// server/modules/tds.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// TDS MANAGEMENT v2 — both directions, per firm, per quarter (migration 169).
//
//   GET  /overview                         per firm: on us / by us / gaps / calendar
//   POST /rebuild                          rebuild liabilities + credits from documents
//   GET  /receivable?fy                    credits per customer × quarter (+ 26AS match)
//   PATCH /receivable/:id                  Form 16A no / received date / note
//   POST /receivable/26as-upload           multipart CSV/TXT from TRACES (Form 26AS / AIS) → match
//   GET  /payable?fy&firm                  liabilities (DUE / PROJECTED / BLOCKED / DEPOSITED)
//   GET  /deductees · POST /deductees · PATCH /deductees/:id   PAN, entity, 194C(6)
//   PATCH /firms/:id                       TAN
//   GET  /challans · POST /challans        ITNS 281 register; posting Dr TDS Payable (194C) / Cr bank
//   GET  /returns · POST /returns/:firm/:fy/:q/pack · PATCH /returns/:id   26Q pack, filed token
//   GET  /export/26q?firm&fy&q             deductee annexure CSV (RPU column order)
//   GET  /export/27a?firm&fy&q             cover totals CSV
//   GET  /export/16a?firm&fy&q             Form 16A issue list CSV
//   GET  /export/credit-claim?firm&fy      TDS on us: documents vs 26AS, for the CA
// ─────────────────────────────────────────────────────────────────────────────
import multipart from '@fastify/multipart';
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FY_RE = /^\d{4}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v) || 0;
const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows, cols) => [cols.map((c) => csvCell(c[0])).join(','), ...rows.map((r) => cols.map((c) => csvCell(typeof c[1] === 'function' ? c[1](r) : r[c[1]])).join(','))].join('\r\n');
const fyNow = async () => (await query('SELECT fy_of(current_date) AS fy')).rows[0].fy;
const PAYABLE_LEDGER = 'TDS Payable (194C)';

export async function registerTdsRoutes(app) {
  const staff = { preHandler: requireAuth };
  const admin = { preHandler: requireAdminRole };
  const actor = (req) => req.user?.name ?? req.user?.sub ?? 'desk';
  const sendCsv = (reply, name, body) => reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}"`).send('﻿' + body);

  app.get('/overview', staff, async () => {
    const fy = await fyNow();
    const { rows: firms } = await query('SELECT * FROM v_tds_overview ORDER BY company_name');
    const { rows: months } = await query(`SELECT * FROM v_tds_payable_month WHERE fy_of(period_month) = $1 ORDER BY company_name, period_month`, [fy]);
    const { rows: returns } = await query(`SELECT r.*, tds_return_due(r.fy, r.quarter) AS due FROM tds_returns r WHERE r.fy = $1 ORDER BY company_id, quarter`, [fy]);
    const { rows: [cal] } = await query(`SELECT fq_of(current_date) AS quarter, tds_return_due($1, fq_of(current_date)) AS return_due, tds_deposit_due(date_trunc('month', current_date)::date) AS deposit_due_this_month, tds_deposit_due((date_trunc('month', current_date) - interval '1 month')::date) AS deposit_due_last_month`, [fy]);
    return { fy, firms, months, returns, calendar: cal };
  });

  app.post('/rebuild', staff, async (req) => {
    const fy = FY_RE.test(String(req.body?.fy ?? '')) ? req.body.fy : await fyNow();
    const { rows: [r] } = await query('SELECT * FROM tds_rebuild($1)', [fy]);
    return { fy, ...r };
  });

  // ── TDS on us ─────────────────────────────────────────────────────────────
  app.get('/receivable', staff, async (req) => {
    const fy = FY_RE.test(String(req.query?.fy ?? '')) ? req.query.fy : await fyNow();
    const { rows } = await query(`SELECT c.*, tds_return_due(c.fy, c.quarter) AS form16a_due FROM tds_credits c WHERE c.fy = $1 ORDER BY c.company_name, c.customer_name, c.quarter, c.source`, [fy]);
    const { rows: uploads } = await query(`SELECT company_id, import_file, count(*)::int AS lines, sum(tds_deducted)::numeric(14,2) AS tds, max(created_at) AS at FROM tds_26as_lines WHERE fy = $1 OR fy IS NULL GROUP BY 1,2 ORDER BY 3 DESC`, [fy]);
    const { rows: ledger } = await query(`SELECT to_char(entry_date, 'YYYY-MM') AS month, source_type, sum(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END)::numeric(14,2) AS net FROM ledger_entries WHERE ledger_name = 'TDS Receivable 194C' AND entry_date >= make_date(split_part($1, '-', 1)::int, 4, 1) GROUP BY 1,2 ORDER BY 1,2`, [fy]);
    return { fy, rows, uploads, ledger };
  });
  app.patch('/receivable/:id', staff, async (req, reply) => {
    const id = String(req.params.id ?? ''); if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const b = req.body ?? {};
    const { rows } = await query(`UPDATE tds_credits SET form16a_no = COALESCE($2, form16a_no), form16a_received_at = COALESCE($3::date, form16a_received_at), note = COALESCE($4, note), deductor_tan = COALESCE($5, deductor_tan), updated_at = now() WHERE id = $1::uuid RETURNING *`,
      [id, b.form16a_no ?? null, DATE_RE.test(String(b.form16a_received_at ?? '')) ? b.form16a_received_at : null, b.note ?? null, b.deductor_tan ?? null]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { updated: true, row: rows[0] };
  });

  // Form 26AS / AIS: TRACES gives a text/CSV export. Columns vary by year;
  // we read by header name (deductor name, TAN, section, date, amount, tds).
  await app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
    scope.post('/receivable/26as-upload', staff, async (req, reply) => {
      let part; try { part = await req.file(); } catch (e) { return reply.code(400).send({ error: 'BAD_MULTIPART', detail: e.message }); }
      if (!part) return reply.code(400).send({ error: 'NO_FILE' });
      const firmId = String(part.fields?.company_id?.value ?? ''); if (!UUID_RE.test(firmId)) return reply.code(400).send({ error: 'NO_FIRM', detail: 'Choose the firm this 26AS belongs to' });
      const text = (await part.toBuffer()).toString('utf8');
      const lines = text.split(/\r?\n/).map((l) => l.replace(/^﻿/, '')).filter((l) => l.trim());
      const sep = lines[0]?.includes('\t') ? '\t' : lines[0]?.includes('^') ? '^' : ',';
      const split = (l) => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((s) => s.trim()); };
      const hi = lines.findIndex((l) => /deductor|tan/i.test(l) && /tds|tax/i.test(l));
      if (hi < 0) return reply.code(422).send({ error: 'NO_HEADER', detail: 'Could not find the column header (Name of Deductor / TAN / TDS) — export the 26AS as text/CSV from TRACES' });
      const hdr = split(lines[hi]).map((h) => h.toLowerCase());
      const col = (...names) => hdr.findIndex((h) => names.some((n) => h.includes(n)));
      const ci = { name: col('name of deductor', 'deductor name', 'deductor'), tan: col('tan'), section: col('section'), date: col('date of transaction', 'date of payment', 'transaction date', 'date'), amt: col('amount paid', 'amount credited', 'amount'), tds: col('tax deducted', 'tds deducted', 'tds'), dep: col('tds deposited', 'tax deposited', 'deposited'), status: col('status of booking', 'status') };
      const toDate = (s) => { const m = String(s).match(/(\d{2})[-/](\w{3}|\d{2})[-/](\d{4})/); if (!m) return null; const mon = isNaN(m[2]) ? { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[m[2].toLowerCase()] : Number(m[2]); return mon ? `${m[3]}-${String(mon).padStart(2, '0')}-${m[1]}` : null; };
      let inserted = 0, seen = 0;
      for (const l of lines.slice(hi + 1)) {
        const c = split(l); const g = (i) => (i >= 0 && i < c.length ? c[i] : '');
        const tds = num(String(g(ci.tds)).replace(/[^0-9.-]/g, '')); if (!tds) continue;
        const d = toDate(g(ci.date));
        const uid = crypto.createHash('md5').update(`${g(ci.tan)}|${g(ci.name)}|${d}|${g(ci.amt)}|${tds}`).digest('hex');
        const { rowCount } = await query(`INSERT INTO tds_26as_lines (company_id, import_file, deductor_tan, deductor_name, section, fy, quarter, txn_date, amount_paid, tds_deducted, tds_deposited, status_of_booking, raw, line_uid)
          VALUES ($1::uuid, $2, $3, $4, $5, CASE WHEN $6::date IS NULL THEN NULL ELSE fy_of($6::date) END, CASE WHEN $6::date IS NULL THEN NULL ELSE fq_of($6::date) END, $6::date, $7, $8, $9, $10, $11::jsonb, $12) ON CONFLICT (company_id, line_uid) DO NOTHING`,
          [firmId, part.filename ?? '26AS', g(ci.tan) || null, g(ci.name) || null, g(ci.section) || null, d, num(String(g(ci.amt)).replace(/[^0-9.-]/g, '')), tds, num(String(g(ci.dep)).replace(/[^0-9.-]/g, '')) || null, g(ci.status) || null, JSON.stringify(c.slice(0, 20)), uid]);
        if (rowCount) inserted += 1; else seen += 1;
      }
      const { rows: [r] } = await query('SELECT * FROM tds_rebuild(fy_of(current_date))');
      return { ok: true, inserted, seen, rebuilt: r, summary: `${part.filename}: ${inserted} 26AS line(s) read (${seen} already held) — credits re-matched.` };
    });
  });

  // ── TDS by us ─────────────────────────────────────────────────────────────
  app.get('/payable', staff, async (req) => {
    const fy = FY_RE.test(String(req.query?.fy ?? '')) ? req.query.fy : await fyNow();
    const firm = UUID_RE.test(String(req.query?.firm ?? '')) ? req.query.firm : null;
    const { rows } = await query(`SELECT l.*, d.pan, d.entity_type, d.declaration_194c6, ch.challan_serial, ch.paid_on AS challan_paid_on
                                    FROM tds_liabilities l LEFT JOIN tds_deductees d ON d.id = l.deductee_id LEFT JOIN tds_challans ch ON ch.id = l.challan_id
                                   WHERE fy_of(l.period_month) = $1 AND ($2::uuid IS NULL OR l.company_id = $2::uuid)
                                   ORDER BY l.company_name, l.period_month, l.deductee_name, l.bill_no`, [fy, firm]);
    const { rows: months } = await query(`SELECT * FROM v_tds_payable_month WHERE fy_of(period_month) = $1 AND ($2::uuid IS NULL OR company_id = $2::uuid) ORDER BY company_name, period_month`, [fy, firm]);
    return { fy, rows, months };
  });

  app.get('/deductees', staff, async () => {
    const { rows } = await query(`SELECT d.*, tds_rate_for(d.pan, d.entity_type, d.declaration_194c6) AS rate_pct,
                                         (SELECT count(*)::int FROM tds_liabilities l WHERE l.deductee_id = d.id) AS liabilities,
                                         (SELECT COALESCE(sum(base_amount), 0)::numeric(14,2) FROM tds_liabilities l WHERE l.deductee_id = d.id AND fy_of(l.period_month) = fy_of(current_date)) AS paid_fy
                                    FROM tds_deductees d ORDER BY d.deductee_kind, d.name`);
    return { rows };
  });
  const saveDeductee = async (b, who, id = null) => {
    const pan = String(b.pan ?? '').toUpperCase().trim() || null;
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw Object.assign(new Error('PAN must look like ABCDE1234F'), { code: 'BAD_PAN' });
    const entity = ['INDIVIDUAL', 'HUF', 'FIRM', 'COMPANY', 'AOP', 'OTHER'].includes(b.entity_type) ? b.entity_type : null;
    const decl = !!b.declaration_194c6;
    if (decl && !pan) throw Object.assign(new Error('A 194C(6) declaration needs the PAN'), { code: 'DECL_NEEDS_PAN' });
    if (decl && Number(b.carriages) > 10) throw Object.assign(new Error('194C(6) applies only to a transporter with 10 or fewer goods carriages'), { code: 'DECL_TOO_MANY' });
    if (id) {
      const { rows } = await query(`UPDATE tds_deductees SET pan = $2, entity_type = $3, declaration_194c6 = $4, declaration_fy = $5, carriages = COALESCE($6, carriages), address = COALESCE($7, address), notes = COALESCE($8, notes), updated_by = $9, updated_at = now() WHERE id = $1::uuid RETURNING *`,
        [id, pan, entity, decl, decl ? (b.declaration_fy ?? null) : null, b.carriages ?? null, b.address ?? null, b.notes ?? null, who]);
      return rows[0];
    }
    const kind = ['OWNER', 'PARTNER', 'VENDOR', 'OTHER'].includes(b.deductee_kind) ? b.deductee_kind : 'OTHER';
    const { rows } = await query(`INSERT INTO tds_deductees (deductee_kind, name, pan, entity_type, declaration_194c6, declaration_fy, carriages, address, notes, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (deductee_kind, upper(btrim(name))) DO UPDATE SET pan = EXCLUDED.pan, entity_type = EXCLUDED.entity_type, declaration_194c6 = EXCLUDED.declaration_194c6, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING *`,
      [kind, String(b.name ?? '').trim(), pan, entity, decl, decl ? (b.declaration_fy ?? null) : null, b.carriages ?? null, b.address ?? null, b.notes ?? null, who]);
    return rows[0];
  };
  app.post('/deductees', staff, async (req, reply) => { try { const d = await saveDeductee(req.body ?? {}, actor(req)); await query('SELECT tds_liabilities_rebuild()'); return { row: d }; } catch (e) { return reply.code(400).send({ error: e.code ?? 'BAD_INPUT', detail: e.message }); } });
  app.patch('/deductees/:id', staff, async (req, reply) => {
    const id = String(req.params.id ?? ''); if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    try { const d = await saveDeductee(req.body ?? {}, actor(req), id); await query('SELECT tds_liabilities_rebuild()'); return { row: d }; } catch (e) { return reply.code(400).send({ error: e.code ?? 'BAD_INPUT', detail: e.message }); }
  });
  app.patch('/firms/:id', admin, async (req, reply) => {
    const id = String(req.params.id ?? ''); if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const tan = String(req.body?.tan ?? '').toUpperCase().trim() || null;
    if (tan && !/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(tan)) return reply.code(400).send({ error: 'BAD_TAN', detail: 'TAN must look like ABCD12345E' });
    const { rows } = await query('UPDATE companies SET tan = $2 WHERE id = $1::uuid RETURNING id, company_name, tan', [id, tan]);
    return { row: rows[0] };
  });

  // ── Challans ──────────────────────────────────────────────────────────────
  app.get('/challans', staff, async (req) => {
    const fy = FY_RE.test(String(req.query?.fy ?? '')) ? req.query.fy : await fyNow();
    const { rows } = await query(`SELECT ch.*, c.company_name, (SELECT count(*)::int FROM tds_liabilities l WHERE l.challan_id = ch.id) AS lines, (SELECT COALESCE(sum(tds_amount), 0)::numeric(14,2) FROM tds_liabilities l WHERE l.challan_id = ch.id) AS covered
                                    FROM tds_challans ch JOIN companies c ON c.id = ch.company_id WHERE fy_of(ch.period_month) = $1 ORDER BY ch.paid_on DESC`, [fy]);
    return { fy, rows };
  });
  app.post('/challans', admin, async (req, reply) => {
    const b = req.body ?? {};
    if (!UUID_RE.test(String(b.company_id ?? ''))) return reply.code(400).send({ error: 'NO_FIRM' });
    if (!DATE_RE.test(String(b.period_month ?? '')) || !DATE_RE.test(String(b.paid_on ?? ''))) return reply.code(400).send({ error: 'BAD_DATE' });
    const amount = r2(num(b.amount)); if (amount <= 0) return reply.code(400).send({ error: 'BAD_AMOUNT' });
    const { rows: [firm] } = await query('SELECT id, company_name, tan FROM companies WHERE id = $1::uuid', [b.company_id]);
    if (!firm) return reply.code(404).send({ error: 'NO_FIRM' });
    const month = String(b.period_month).slice(0, 8) + '01';
    const bank = String(b.bank_ledger ?? '').trim() || null;
    let voucher = null;
    if (bank && b.post !== false) {
      try {
        const v = await postVoucher({ type: 'JOURNAL', source_type: 'TDS_CHALLAN', company_id: firm.id, ref_no: `CHALLAN-${(b.challan_serial || crypto.randomUUID().slice(0, 8)).toString().replace(/\s+/g, '')}-${month.slice(0, 7)}`, entry_date: b.paid_on, created_by: actor(req),
          narration: `TDS 194C deposited for ${month.slice(0, 7)} — ITNS 281 challan ${b.challan_serial ?? ''} BSR ${b.bsr_code ?? ''}`,
          lines: [{ ledger: PAYABLE_LEDGER, dr_cr: 'DR', amount: r2(amount + num(b.interest) + num(b.fee)), group: 'Duties & Taxes' }, { ledger: bank, dr_cr: 'CR', amount: r2(amount + num(b.interest) + num(b.fee)), group: 'Bank Accounts' }] });
        voucher = v?.voucher_id ?? null;
      } catch (e) { if (e.code !== 'DUPLICATE_REF') return reply.code(422).send({ error: e.code ?? 'POSTING_FAILED', detail: e.message }); }
    }
    const { rows: [ch] } = await query(`INSERT INTO tds_challans (company_id, tan, section, period_month, amount, interest, fee, bsr_code, challan_serial, paid_on, bank_ledger, voucher_id, note, created_by)
      VALUES ($1::uuid, $2, '194C', $3::date, $4, $5, $6, $7, $8, $9::date, $10, $11::uuid, $12, $13) RETURNING *`,
      [firm.id, firm.tan, month, amount, r2(num(b.interest)), r2(num(b.fee)), b.bsr_code ?? null, b.challan_serial ?? null, b.paid_on, bank, voucher, b.note ?? null, actor(req)]);
    // cover the month's DUE liabilities, oldest first, up to the challan amount
    const { rows: due } = await query(`SELECT id, tds_amount FROM tds_liabilities WHERE company_id = $1::uuid AND period_month = $2::date AND status = 'DUE' ORDER BY credit_date, deductee_name`, [firm.id, month]);
    let left = amount; const covered = [];
    for (const l of due) { if (num(l.tds_amount) <= left + 0.005) { covered.push(l.id); left = r2(left - num(l.tds_amount)); } }
    if (covered.length) await query(`UPDATE tds_liabilities SET status = 'DEPOSITED', challan_id = $2::uuid, updated_at = now() WHERE id = ANY($1::uuid[])`, [covered, ch.id]);
    return { challan: ch, covered: covered.length, uncovered_amount: left, voucher_id: voucher };
  });

  // ── Returns and the government pack ──────────────────────────────────────
  const packQuery = async (firmId, fy, q) => {
    const { rows: firm } = await query('SELECT id, company_name, pan_no, tan FROM companies WHERE id = $1::uuid', [firmId]);
    const { rows } = await query(`
      SELECT l.*, d.pan, d.entity_type, d.declaration_194c6, ch.bsr_code, ch.challan_serial, ch.paid_on AS challan_date, ch.amount AS challan_amount
        FROM tds_liabilities l LEFT JOIN tds_deductees d ON d.id = l.deductee_id LEFT JOIN tds_challans ch ON ch.id = l.challan_id
       WHERE l.company_id = $1::uuid AND fy_of(l.period_month) = $2 AND fq_of(l.period_month) = $3 AND l.status IN ('DUE','DEPOSITED','RETURNED','EXEMPT')
       ORDER BY l.deductee_name, l.credit_date`, [firmId, fy, q]);
    return { firm: firm[0], rows };
  };
  app.get('/returns', staff, async (req) => {
    const fy = FY_RE.test(String(req.query?.fy ?? '')) ? req.query.fy : await fyNow();
    const { rows } = await query(`SELECT r.*, c.company_name, tds_return_due(r.fy, r.quarter) AS due FROM tds_returns r JOIN companies c ON c.id = r.company_id WHERE r.fy = $1 ORDER BY c.company_name, r.quarter`, [fy]);
    const { rows: quarters } = await query(`
      SELECT c.id AS company_id, c.company_name, c.tan, fy_of(l.period_month) AS fy, fq_of(l.period_month) AS quarter, tds_return_due(fy_of(l.period_month), fq_of(l.period_month)) AS due,
             count(DISTINCT l.deductee_name)::int AS deductees, sum(l.base_amount)::numeric(14,2) AS amount_paid, sum(l.tds_amount) FILTER (WHERE l.status <> 'EXEMPT')::numeric(14,2) AS tds_deducted,
             sum(l.tds_amount) FILTER (WHERE l.status IN ('DEPOSITED','RETURNED'))::numeric(14,2) AS tds_deposited, count(*) FILTER (WHERE l.status = 'DUE')::int AS undeposited
        FROM tds_liabilities l JOIN companies c ON c.id = l.company_id
       WHERE fy_of(l.period_month) = $1 AND l.status IN ('DUE','DEPOSITED','RETURNED','EXEMPT') GROUP BY 1,2,3,4,5 ORDER BY 2,5`, [fy]);
    return { fy, returns: rows, quarters };
  });
  app.post('/returns/:firm/:fy/:q/pack', staff, async (req, reply) => {
    const { firm, fy, q } = req.params; if (!UUID_RE.test(firm) || !FY_RE.test(fy) || !['Q1', 'Q2', 'Q3', 'Q4'].includes(q)) return reply.code(400).send({ error: 'BAD_INPUT' });
    const p = await packQuery(firm, fy, q);
    const tot = p.rows.reduce((t, r) => ({ n: t.n.add(r.deductee_name), paid: t.paid + num(r.base_amount), tds: t.tds + (r.status === 'EXEMPT' ? 0 : num(r.tds_amount)), dep: t.dep + (['DEPOSITED', 'RETURNED'].includes(r.status) ? num(r.tds_amount) : 0) }), { n: new Set(), paid: 0, tds: 0, dep: 0 });
    const { rows: [r] } = await query(`INSERT INTO tds_returns (company_id, fy, quarter, form, status, pack_generated_at, deductees, amount_paid, tds_deducted, tds_deposited, updated_by)
      VALUES ($1::uuid, $2, $3, '26Q', 'PACK_READY', now(), $4, $5, $6, $7, $8)
      ON CONFLICT (company_id, fy, quarter, form) DO UPDATE SET status = CASE WHEN tds_returns.status = 'FILED' THEN 'FILED' ELSE 'PACK_READY' END, pack_generated_at = now(), deductees = EXCLUDED.deductees, amount_paid = EXCLUDED.amount_paid, tds_deducted = EXCLUDED.tds_deducted, tds_deposited = EXCLUDED.tds_deposited, updated_by = EXCLUDED.updated_by, updated_at = now()
      RETURNING *`, [firm, fy, q, tot.n.size, r2(tot.paid), r2(tot.tds), r2(tot.dep), actor(req)]);
    await query(`UPDATE tds_liabilities SET return_id = $1::uuid WHERE company_id = $2::uuid AND fy_of(period_month) = $3 AND fq_of(period_month) = $4 AND status IN ('DEPOSITED','RETURNED','EXEMPT')`, [r.id, firm, fy, q]);
    return { return: r, lines: p.rows.length, undeposited: p.rows.filter((x) => x.status === 'DUE').length, warnings: [
      ...(p.firm?.tan ? [] : ['TAN missing on the firm — the return cannot be filed without it']),
      ...(p.rows.some((x) => !x.pan && x.status !== 'EXEMPT') ? ['deductee(s) without PAN — 20% applies and PAN is mandatory in the return'] : []),
      ...(p.rows.some((x) => x.status === 'DUE') ? ['undeposited TDS in this quarter — record the challan(s) first'] : []),
    ] };
  });
  app.patch('/returns/:id', admin, async (req, reply) => {
    const id = String(req.params.id ?? ''); if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const b = req.body ?? {};
    const { rows } = await query(`UPDATE tds_returns SET status = COALESCE($2, status), filed_on = COALESCE($3::date, filed_on), token_no = COALESCE($4, token_no), note = COALESCE($5, note), updated_by = $6, updated_at = now() WHERE id = $1::uuid RETURNING *`,
      [id, ['DRAFT', 'PACK_READY', 'FILED', 'CORRECTION'].includes(b.status) ? b.status : null, DATE_RE.test(String(b.filed_on ?? '')) ? b.filed_on : null, b.token_no ?? null, b.note ?? null, actor(req)]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (rows[0].status === 'FILED') await query(`UPDATE tds_liabilities SET status = 'RETURNED', updated_at = now() WHERE return_id = $1::uuid AND status = 'DEPOSITED'`, [id]);
    return { row: rows[0] };
  });

  // ── Exports ───────────────────────────────────────────────────────────────
  const parseFQ = (req) => ({ firm: UUID_RE.test(String(req.query?.firm ?? '')) ? req.query.firm : null, fy: FY_RE.test(String(req.query?.fy ?? '')) ? req.query.fy : null, q: ['Q1', 'Q2', 'Q3', 'Q4'].includes(req.query?.q) ? req.query.q : null });
  // Deductee annexure in the RPU (26Q) column order.
  app.get('/export/26q', staff, async (req, reply) => {
    const { firm, fy, q } = parseFQ(req); if (!firm || !fy || !q) return reply.code(400).send({ error: 'BAD_INPUT', detail: 'firm, fy (2026-27) and q (Q1..Q4) are required' });
    const p = await packQuery(firm, fy, q);
    const cols = [['Sr No', (r, i) => i + 1], ['Deductor TAN', () => p.firm?.tan ?? ''], ['Deductor Name', () => p.firm?.company_name ?? ''], ['Deductee Code (01 company / 02 other)', (r) => (r.entity_type === 'COMPANY' ? '01' : '02')],
      ['Deductee PAN', (r) => r.pan ?? 'PANNOTAVBL'], ['Deductee Name', 'deductee_name'], ['Section', 'section'], ['Date of Payment / Credit', (r) => String(r.credit_date).slice(0, 10)], ['Amount Paid / Credited', (r) => r2(r.base_amount).toFixed(2)],
      ['TDS', (r) => (r.status === 'EXEMPT' ? '0.00' : r2(r.tds_amount).toFixed(2))], ['Surcharge', () => '0.00'], ['Education Cess', () => '0.00'], ['Total Tax Deducted', (r) => (r.status === 'EXEMPT' ? '0.00' : r2(r.tds_amount).toFixed(2))],
      ['Total Tax Deposited', (r) => (['DEPOSITED', 'RETURNED'].includes(r.status) ? r2(r.tds_amount).toFixed(2) : '0.00')], ['Date of Deduction', (r) => String(r.credit_date).slice(0, 10)], ['Rate at which deducted', (r) => (r.rate_pct === null ? '' : Number(r.rate_pct).toFixed(2))],
      ['Reason for non/lower deduction', (r) => (r.status === 'EXEMPT' && r.declaration_194c6 ? 'T' : !r.pan ? 'C' : '')], ['Certificate No (197)', () => ''],
      ['Challan BSR Code', (r) => r.bsr_code ?? ''], ['Challan Date', (r) => (r.challan_date ? String(r.challan_date).slice(0, 10) : '')], ['Challan Serial No', (r) => r.challan_serial ?? ''], ['Bill / Source', (r) => r.bill_no ?? r.source_kind], ['Status in ERP', 'status']];
    const body = [cols.map((c) => csvCell(c[0])).join(','), ...p.rows.map((r, i) => cols.map((c) => csvCell(typeof c[1] === 'function' ? c[1](r, i) : r[c[1]])).join(','))].join('\r\n');
    return sendCsv(reply, `26Q_${(p.firm?.company_name ?? 'firm').replace(/[^A-Za-z]+/g, '_')}_${fy}_${q}.csv`, body);
  });
  app.get('/export/27a', staff, async (req, reply) => {
    const { firm, fy, q } = parseFQ(req); if (!firm || !fy || !q) return reply.code(400).send({ error: 'BAD_INPUT' });
    const p = await packQuery(firm, fy, q);
    const { rows: ch } = await query(`SELECT * FROM tds_challans WHERE company_id = $1::uuid AND fy_of(period_month) = $2 AND fq_of(period_month) = $3 ORDER BY paid_on`, [firm, fy, q]);
    const deductees = new Set(p.rows.map((r) => r.deductee_name)).size;
    const paid = r2(p.rows.reduce((n, r) => n + num(r.base_amount), 0)); const tds = r2(p.rows.reduce((n, r) => n + (r.status === 'EXEMPT' ? 0 : num(r.tds_amount)), 0)); const dep = r2(ch.reduce((n, c) => n + num(c.amount), 0));
    const body = ['Form 27A cover figures,Value', `Deductor,${csvCell(p.firm?.company_name)}`, `TAN,${csvCell(p.firm?.tan ?? 'MISSING')}`, `PAN,${csvCell(p.firm?.pan_no)}`, `Form,26Q`, `Financial Year,${fy}`, `Quarter,${q}`, `Due date,${(await query('SELECT tds_return_due($1,$2) AS d', [fy, q])).rows[0].d}`,
      `Number of deductee records,${p.rows.length}`, `Number of deductees,${deductees}`, `Total amount paid / credited,${paid.toFixed(2)}`, `Total tax deducted,${tds.toFixed(2)}`, `Total tax deposited (challans),${dep.toFixed(2)}`, `Number of challans,${ch.length}`, `Difference (deducted − deposited),${r2(tds - dep).toFixed(2)}`, '',
      'Challan sr,Period month,BSR code,Challan serial,Date,Amount,Interest,Fee', ...ch.map((c, i) => [i + 1, String(c.period_month).slice(0, 7), c.bsr_code ?? '', c.challan_serial ?? '', String(c.paid_on).slice(0, 10), r2(c.amount).toFixed(2), r2(c.interest).toFixed(2), r2(c.fee).toFixed(2)].map(csvCell).join(','))].join('\r\n');
    return sendCsv(reply, `27A_${fy}_${q}.csv`, body);
  });
  app.get('/export/16a', staff, async (req, reply) => {
    const { firm, fy, q } = parseFQ(req); if (!firm || !fy || !q) return reply.code(400).send({ error: 'BAD_INPUT' });
    const p = await packQuery(firm, fy, q);
    const byD = new Map();
    for (const r of p.rows) { const k = r.deductee_name; const x = byD.get(k) ?? { deductee_name: k, pan: r.pan ?? '', entity_type: r.entity_type ?? '', paid: 0, tds: 0, lines: 0 }; x.paid += num(r.base_amount); x.tds += r.status === 'EXEMPT' ? 0 : num(r.tds_amount); x.lines += 1; byD.set(k, x); }
    const body = csv([...byD.values()], [['Deductee', 'deductee_name'], ['PAN', 'pan'], ['Entity', 'entity_type'], ['Amount paid / credited', (r) => r2(r.paid).toFixed(2)], ['TDS deducted', (r) => r2(r.tds).toFixed(2)], ['Lines', 'lines'], ['Form 16A due', () => ''], ['Certificate no (from TRACES)', () => ''], ['Issued on', () => '']]);
    return sendCsv(reply, `Form16A_issue_list_${fy}_${q}.csv`, body);
  });
  app.get('/export/credit-claim', staff, async (req, reply) => {
    const { firm, fy } = parseFQ(req); const fyy = fy ?? (await fyNow());
    const { rows } = await query(`SELECT c.*, co.pan_no FROM tds_credits c LEFT JOIN companies co ON co.id = c.company_id WHERE c.fy = $1 AND ($2::uuid IS NULL OR c.company_id = $2::uuid) ORDER BY c.company_name, c.quarter, c.customer_name, c.source`, [fyy, firm]);
    const body = csv(rows, [['Firm', 'company_name'], ['Firm PAN', 'pan_no'], ['FY', 'fy'], ['Quarter', 'quarter'], ['Deductor (customer)', 'customer_name'], ['Deductor TAN', 'deductor_tan'], ['Section', 'section'], ['Amount paid / credited (documents)', (r) => r2(r.freight_base).toFixed(2)], ['TDS per documents', (r) => r2(r.tds_amount).toFixed(2)], ['Source', 'source'], ['Documents', 'documents'], ['TDS per Form 26AS', (r) => (r.amount_26as === null ? '' : r2(r.amount_26as).toFixed(2))], ['Difference', (r) => (r.amount_26as === null ? '' : r2(num(r.amount_26as) - num(r.tds_amount)).toFixed(2))], ['State', 'matched_state'], ['Form 16A no', 'form16a_no'], ['Form 16A received', (r) => (r.form16a_received_at ? String(r.form16a_received_at).slice(0, 10) : '')], ['Note', 'note']]);
    return sendCsv(reply, `TDS_credit_claim_${fyy}.csv`, body);
  });
}
