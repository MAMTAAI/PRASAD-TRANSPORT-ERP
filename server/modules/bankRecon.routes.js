// server/modules/bankRecon.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// BANK RECONCILIATION — upload a statement, let TARA tally it, decide the rest.
//
//   GET  /summary                       accounts (statement vs book), totals, rules
//   POST /statements/upload             multipart: file (PDF/CSV/XLSX), password?, account? → parse → import → tally
//   POST /statements/import-json        {account_no, meta, lines[]} — a parsed file (scripts/bank-import.mjs)
//   POST /tally                         re-run TARA on NEW/REVIEW lines (rules learned since)
//   GET  /lines?account&status&q&from&to&limit   the book / the desk
//   GET  /lines/:id                     the line + everything it could link to
//   POST /lines/:id/link                a person decides (see bankTally.linkLine)
//   GET  /book-unmatched?account        book entries with no bank line (flagged, decision 4)
//   GET  /rules · DELETE /rules/:id     what TARA has been taught
//   GET  /accounts · POST /accounts     the account ↔ ledger ↔ firm register (admin)
// ─────────────────────────────────────────────────────────────────────────────
import multipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';
import { runChild, PYTHON, REPO, tail as tailOf } from '../lib/adviceCollectJob.js';
import { importParsed, tallyAccount, candidatesFor, linkLine, bankSummary, accountByNo, CATEGORIES } from '../lib/bankTally.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PARSER = path.join(REPO, 'tools', 'bank', 'parse_sbi_statement.py');
const UPLOAD_DIR = path.join(REPO, 'uploads', 'bank_statements');

export async function registerBankReconRoutes(app) {
  const staff = { preHandler: requireAuth };
  const admin = { preHandler: requireAdminRole };
  const actor = (req) => req.user?.name ?? req.user?.sub ?? 'desk';

  app.get('/summary', staff, async () => bankSummary());

  app.get('/accounts', staff, async () => ({ accounts: (await query('SELECT * FROM v_bank_account_summary ORDER BY company_name, ledger_name')).rows }));
  app.post('/accounts', admin, async (req, reply) => {
    const b = req.body ?? {};
    const no = String(b.account_no ?? '').replace(/\D/g, ''); const ledger = String(b.ledger_name ?? '').trim();
    if (no.length < 9 || !ledger) return reply.code(400).send({ error: 'BAD_INPUT', detail: 'account_no and ledger_name are required' });
    const { rows: [co] } = await query('SELECT id, company_name FROM companies WHERE id = $1::uuid OR company_name ILIKE $2 LIMIT 1', [UUID_RE.test(String(b.company_id ?? '')) ? b.company_id : null, `%${String(b.company_name ?? '').trim()}%`]);
    await query('SELECT ensure_bank_ledger($1, $2, $3)', [ledger, 'Bank Accounts', co?.company_name ?? null]);
    const { rows: [a] } = await query(`INSERT INTO bank_accounts (account_no, account_tail, bank_name, ifsc, ledger_name, company_id, company_name, account_kind, personal_default_not_ours)
                                       VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9)
                                       ON CONFLICT (account_no) DO UPDATE SET ledger_name = EXCLUDED.ledger_name, company_id = EXCLUDED.company_id, company_name = EXCLUDED.company_name, account_kind = EXCLUDED.account_kind, personal_default_not_ours = EXCLUDED.personal_default_not_ours
                                       RETURNING *`,
      [no, no.slice(-4), String(b.bank_name ?? 'STATE BANK OF INDIA'), b.ifsc ?? null, ledger, co?.id ?? null, co?.company_name ?? null, ['CURRENT', 'SAVINGS', 'OD', 'CC'].includes(b.account_kind) ? b.account_kind : 'CURRENT', !!b.personal_default_not_ours]);
    return { account: a };
  });

  // ── upload → parse → import → tally ─────────────────────────────────────
  await app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: 40 * 1024 * 1024, files: 1 } });
    scope.post('/statements/upload', staff, async (req, reply) => {
      let part;
      try { part = await req.file(); } catch (e) { return reply.code(400).send({ error: 'BAD_MULTIPART', detail: e.message }); }
      if (!part) return reply.code(400).send({ error: 'NO_FILE', detail: 'Attach the statement (PDF, CSV or XLSX)' });
      const buf = await part.toBuffer();
      const ext = (path.extname(part.filename || '').toLowerCase() || '.pdf');
      if (!['.pdf', '.csv', '.xlsx', '.xls', '.txt'].includes(ext)) return reply.code(400).send({ error: 'BAD_TYPE', detail: 'PDF, CSV or XLSX only' });
      const password = String(part.fields?.password?.value ?? '').trim() || null;
      const accountOverride = String(part.fields?.account?.value ?? '').replace(/\D/g, '') || null;
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const safe = String(part.filename ?? 'statement' + ext).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const dest = path.join(UPLOAD_DIR, `${new Date().toISOString().slice(0, 10)}_${sha.slice(0, 8)}_${safe}`);
      fs.writeFileSync(dest, buf);
      const out = dest + '.json';
      const args = [PARSER, '--file', dest, '--out', out]; if (password) args.push('--password', password); if (accountOverride) args.push('--account', accountOverride);
      const r = await runChild(PYTHON, args, { timeoutMs: 5 * 60 * 1000 });
      if (!r.ok) return reply.code(422).send({ error: 'PARSE_FAILED', detail: tailOf(r.stderr || r.stdout, 4) });
      let parsed; try { parsed = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { return reply.code(422).send({ error: 'PARSE_FAILED', detail: e.message }); }
      fs.rmSync(out, { force: true });
      if (!parsed.lines?.length) return reply.code(422).send({ error: 'NO_LINES', detail: 'The parser found no transaction rows — is this an SBI statement?' });
      const accountNo = accountOverride || parsed.meta?.account_no;
      const acct = await accountByNo(accountNo || '');
      if (!acct) return reply.code(409).send({ error: 'NO_ACCOUNT', detail: `Account ${accountNo || '?'} (${parsed.meta?.account_name ?? ''}) is not on file — add it under Accounts, then upload again`, meta: parsed.meta });
      const imp = await importParsed({ accountNo: acct.account_no, meta: { ...parsed.meta, content_sha: sha }, lines: parsed.lines, sourceFile: path.basename(dest), format: ext === '.pdf' ? 'PDF' : ext === '.csv' || ext === '.txt' ? 'CSV' : 'XLSX', by: actor(req) });
      const tally = await tallyAccount({ accountId: acct.id, statuses: ['NEW'], by: 'agent:TARA', log: req.log });
      return { ok: true, account: { ledger_name: acct.ledger_name, company_name: acct.company_name, account_no: acct.account_no }, meta: parsed.meta, import: { id: imp.import_id, rows_read: imp.rows_read, rows_new: imp.rows_new, rows_seen: imp.rows_seen }, tally,
               summary: `${parsed.meta?.file ?? part.filename}: ${imp.rows_new} new line(s) on ${acct.ledger_name} (${imp.rows_seen} already held) · TARA posted ${tally.auto_posted}, linked ${tally.linked} to the book, ${tally.review} for the desk, ${tally.not_ours} not ours.` };
    });
  });

  app.post('/statements/import-json', admin, async (req, reply) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.lines) || !b.lines.length) return reply.code(400).send({ error: 'NO_LINES' });
    try {
      const imp = await importParsed({ accountNo: b.account_no ?? b.meta?.account_no, meta: b.meta ?? {}, lines: b.lines, sourceFile: b.meta?.file ?? 'json', format: 'JSON', by: actor(req) });
      const tally = b.tally === false ? null : await tallyAccount({ accountId: imp.account.id, statuses: ['NEW'], by: 'agent:TARA', log: req.log });
      return { ok: true, import: imp, tally };
    } catch (e) { if (e.code === 'NO_ACCOUNT') return reply.code(409).send({ error: e.code, detail: e.message }); throw e; }
  });

  app.post('/tally', staff, async (req) => {
    const b = req.body ?? {};
    return tallyAccount({ accountId: UUID_RE.test(String(b.account_id ?? '')) ? b.account_id : null, statuses: Array.isArray(b.statuses) && b.statuses.length ? b.statuses : ['NEW', 'REVIEW'], by: 'agent:TARA', log: req.log });
  });

  // ── the book and the desk ────────────────────────────────────────────────
  app.get('/lines', staff, async (req) => {
    const q = req.query ?? {};
    const account = UUID_RE.test(String(q.account ?? '')) ? q.account : null;
    const statuses = String(q.status ?? '').split(',').map((s) => s.trim()).filter((s) => ['NEW', 'AUTO_POSTED', 'LINKED', 'REVIEW', 'PARKED', 'NOT_OURS', 'IGNORED'].includes(s));
    const text = String(q.q ?? '').trim() || null;
    const from = DATE_RE.test(String(q.from ?? '')) ? q.from : null; const to = DATE_RE.test(String(q.to ?? '')) ? q.to : null;
    const cat = CATEGORIES.includes(String(q.category ?? '')) ? q.category : null;
    const limit = Math.min(Math.max(1, Number(q.limit) || 400), 2000);
    const { rows } = await query(`
      SELECT l.*, a.ledger_name, a.company_name, a.account_tail
        FROM bank_statement_lines l JOIN bank_accounts a ON a.id = l.account_id
       WHERE ($1::uuid IS NULL OR l.account_id = $1::uuid)
         AND ($2::text[] IS NULL OR l.status = ANY($2))
         AND ($3::text IS NULL OR l.description ILIKE '%' || $3 || '%' OR l.counterparty ILIKE '%' || $3 || '%' OR l.utr ILIKE '%' || $3 || '%' OR l.target_label ILIKE '%' || $3 || '%' OR l.ref_no ILIKE '%' || $3 || '%')
         AND ($4::date IS NULL OR l.txn_date >= $4::date) AND ($5::date IS NULL OR l.txn_date <= $5::date)
         AND ($6::text IS NULL OR l.category = $6)
       ORDER BY CASE WHEN l.status IN ('NEW','REVIEW') THEN 0 ELSE 1 END, l.txn_date DESC, l.created_at DESC
       LIMIT $7`, [account, statuses.length ? statuses : null, text, from, to, cat, limit]);
    return { rows, categories: CATEGORIES };
  });

  app.get('/lines/:id', staff, async (req, reply) => {
    const id = String(req.params.id ?? ''); if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const c = await candidatesFor(id); if (!c) return reply.code(404).send({ error: 'NOT_FOUND' });
    return c;
  });

  app.post('/lines/:id/link', staff, async (req, reply) => {
    const id = String(req.params.id ?? ''); if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const d = req.body ?? {};
    if (!d.category) return reply.code(400).send({ error: 'NO_CATEGORY' });
    try { return await linkLine({ lineId: id, decision: d, by: actor(req) }); }
    catch (e) {
      if (['NOT_FOUND', 'ALREADY_POSTED', 'PENDING'].includes(e.code)) return reply.code(e.code === 'NOT_FOUND' ? 404 : 409).send({ error: e.code, detail: e.message });
      return reply.code(422).send({ error: e.code ?? 'LINK_FAILED', detail: e.message });
    }
  });

  app.get('/book-unmatched', staff, async (req) => {
    const account = UUID_RE.test(String(req.query?.account ?? '')) ? req.query.account : null;
    const { rows } = await query(`SELECT * FROM v_bank_book_unmatched WHERE ($1::uuid IS NULL OR account_id = $1::uuid) ORDER BY entry_date DESC LIMIT 1000`, [account]);
    const { rows: by } = await query(`SELECT ledger_name, source_type, count(*)::int AS n, sum(amount)::numeric(14,2) AS amount FROM v_bank_book_unmatched WHERE ($1::uuid IS NULL OR account_id = $1::uuid) GROUP BY 1,2 ORDER BY 1,4 DESC`, [account]);
    return { rows, by_source: by };
  });

  app.get('/rules', staff, async () => ({ rules: (await query('SELECT r.*, a.ledger_name FROM bank_party_rules r LEFT JOIN bank_accounts a ON a.id = r.account_id ORDER BY r.created_at DESC')).rows }));
  app.delete('/rules/:id', admin, async (req, reply) => {
    const id = String(req.params.id ?? ''); if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const { rowCount } = await query('DELETE FROM bank_party_rules WHERE id = $1::uuid', [id]);
    return { deleted: rowCount > 0 };
  });
}
