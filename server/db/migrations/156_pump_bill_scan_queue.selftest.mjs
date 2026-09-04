// server/db/migrations/156_pump_bill_scan_queue.selftest.mjs
//   MIGTEST_PG=… MIGTEST_SCHEMA=…/prod_schema.sql.gz npm run migrate:selftest156
// ─────────────────────────────────────────────────────────────────────────────
// The queue exists so that "we never tried June" and "June would not read" stop
// looking the same. So what is tested is that the two stay distinguishable, and
// that the same file shown twice does not become two jobs.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ADMIN = process.env.MIGTEST_PG;
const SCHEMA = process.env.MIGTEST_SCHEMA;
if (!ADMIN || !SCHEMA) {
  console.log('\n⏭  MIGTEST_PG / MIGTEST_SCHEMA not set — skipping the migration 156 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = 'pt_mig156_test';
let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

function splitSql(sql) {
  const out = []; let buf = ''; let tag = null;
  let inLine = false, inBlock = false, inStr = false;
  const NL = String.fromCharCode(10);
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (inLine) { buf += c; if (c === NL) inLine = false; continue; }
    if (inBlock) { buf += c; if (c === '*' && sql[i + 1] === '/') { buf += '/'; i += 1; inBlock = false; } continue; }
    if (inStr) { buf += c; if (c === "'") { if (sql[i + 1] === "'") { buf += "'"; i += 1; } else inStr = false; } continue; }
    if (tag) { if (sql.startsWith(tag, i)) { buf += tag; i += tag.length - 1; tag = null; } else buf += c; continue; }
    if (c === '-' && sql[i + 1] === '-') { inLine = true; buf += '--'; i += 1; continue; }
    if (c === '/' && sql[i + 1] === '*') { inBlock = true; buf += '/*'; i += 1; continue; }
    if (c === "'") { inStr = true; buf += c; continue; }
    const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40));
    if (m) { tag = m[0]; buf += tag; i += tag.length - 1; continue; }
    if (c === ';') { const s = buf.trim(); if (s) out.push(s); buf = ''; continue; }
    buf += c;
  }
  const last = buf.trim(); if (last) out.push(last);
  return out.filter((s) => s.replace(/--[^\n]*\n?/g, '').trim());
}

const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
const url = ADMIN.replace(/\/[^/]*$/, `/${DB}`);
const raw = execFileSync('gzip', ['-dc', SCHEMA], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
const schemaSql = raw.split('\n').filter((l) => !/^\\/.test(l) && !/^SET [a-z_]+ =/i.test(l)).join('\n');

const db = new pg.Client({ connectionString: url });
await db.connect();

try {
  console.log('\nPRODUCTION SCHEMA + 152→156');
  for (const st of splitSql(schemaSql)) { try { await db.query(st); } catch { /* PostGIS */ } }
  await db.query('SET search_path = public');
  for (const f of ['152_fleet_card_allocation.sql', '153_pump_bill_settlement.sql',
                   '154_fuel_settlement_trail.sql', '155_fortnight_bill_lock.sql',
                   '156_pump_bill_scan_queue.sql']) {
    await db.query(readFileSync(path.join(here, f), 'utf8'));
  }
  check('152–156 apply together', true, true);
  await db.query(readFileSync(path.join(here, '156_pump_bill_scan_queue.sql'), 'utf8'));
  check('156 is re-runnable', true, true);

  const add = async (o) => (await db.query(`
    INSERT INTO pump_bill_scan_queue
      (source_file, content_sha, pages, pump_hint, period_from, period_to, cycle,
       status, reason_code, reason, rows_found, text_lines)
    VALUES ($1,$2,$3,$4,$5::date,$6::date,
            CASE WHEN $5::date IS NOT NULL THEN fortnight_code($5::date) END,
            $7,$8,$9,$10,$11)
    ON CONFLICT (content_sha) DO NOTHING RETURNING id`,
    [o.file, o.sha, o.pages ?? 1, o.pump, o.from ?? null, o.to ?? null,
     o.status ?? 'NEEDS_ENTRY', o.code ?? null, o.reason ?? null,
     o.rows ?? 0, o.text ?? 0])).rows[0];

  console.log('\nTHE SAME FILE IS NOT TWO JOBS');
  const first = await add({ file: 'Alam/June 30.06.2026.pdf', sha: 'aaa', pump: 'ALAM FUEL STATION',
                            from: '2026-06-16', to: '2026-06-30', code: 'UNKNOWN_PUMP_FORMAT', text: 151 });
  check('the first upload queues', !!first, true);
  check('the same file again does not', await add({ file: 'again.pdf', sha: 'aaa', pump: 'ALAM FUEL STATION' }), undefined);
  check('the queue holds one job',
    (await db.query(`SELECT count(*)::int n FROM pump_bill_scan_queue`)).rows[0].n, 1);

  console.log('\nTHE ISSUE, IN WORDS A CLERK CAN ACT ON');
  await add({ file: 'Highway/JULY 15.07.2026.pdf', sha: 'bbb', pump: 'HIGHWAY SERVICE CENTRE',
              from: '2026-07-01', to: '2026-07-15', code: 'UNKNOWN_PUMP_FORMAT', text: 0 });
  await add({ file: 'Sree krishna/Apr 15.04.2026.pdf', sha: 'ccc', pump: 'SREE KRISHNA SERVICE CENTRE',
              from: '2026-04-01', to: '2026-04-15', status: 'PARSED', rows: 7, text: 39 });
  await add({ file: 'BN/May 2026.pdf', sha: 'ddd', pump: 'B N FILLING STATION',
              from: '2026-05-01', to: '2026-05-15', code: 'BILL_DOES_NOT_BALANCE', text: 54, rows: 12 });
  await add({ file: 'mystery.pdf', sha: 'eee', pump: null });

  const issue = async (sha) => (await db.query(
    `SELECT issue FROM v_pump_bill_queue WHERE id = (SELECT id FROM pump_bill_scan_queue WHERE content_sha=$1)`,
    [sha])).rows[0].issue;
  // Zero text is a photograph; text with no usable table is a different
  // conversation with the pump, and the queue says which.
  check('no text at all says so', await issue('bbb'), 'Poori photo — koi text nahi');
  check('text but a broken table says THAT', await issue('aaa'), 'Layout tooti hui — OCR ne table bigaad di');
  check('a bill that does not add up says that', await issue('ddd'), 'Rows apne hi total se nahi milte');
  check('one that read cleanly says so', await issue('ccc'), 'Padh li gayi');

  console.log('\nGROUPED THE WAY IT IS WORKED');
  const { rows: q } = await db.query(
    `SELECT cycle, cycle_label, pump, source_file FROM v_pump_bill_queue
      WHERE status = 'NEEDS_ENTRY' ORDER BY period_from DESC NULLS LAST, pump`);
  check('only the unread ones are in the queue', q.length, 4);
  check('the newest fortnight leads', q[0].cycle, '2026-07-H1');
  check('…with its label', q[0].cycle_label, 'Jul 2026 · 1–15');
  check('June comes next', q[1].cycle, '2026-06-H2');
  // A bill whose date could not be read is still work, and must not pretend to
  // be the newest by sorting first.
  const undated = q.find((r) => r.cycle === 'UNDATED');
  check('an undated bill is still listed', !!undated, true);
  check('…and says its pump is unknown', undated.pump, 'Pump pata nahi');
  check('…and its date is unknown', undated.cycle_label, 'Tareekh pata nahi');

  console.log('\nWORKING IT OFF');
  await db.query(
    `UPDATE pump_bill_scan_queue SET status='ENTERED', resolved_at=now(), resolved_by='desk'
      WHERE content_sha='aaa'`);
  const { rows: [tot] } = await db.query(`
    SELECT count(*) FILTER (WHERE status='NEEDS_ENTRY')::int needs,
           count(*) FILTER (WHERE status='PARSED')::int parsed,
           count(*) FILTER (WHERE status='ENTERED')::int entered
      FROM pump_bill_scan_queue`);
  check('an entered bill leaves the queue', [tot.needs, tot.parsed, tot.entered], [3, 1, 1]);
  // The record of the attempt stays either way — that is the whole point.
  check('but its record remains',
    (await db.query(`SELECT count(*)::int n FROM pump_bill_scan_queue`)).rows[0].n, 5);

  console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
} finally {
  await db.end().catch(() => {});
  const a2 = new pg.Client({ connectionString: ADMIN });
  await a2.connect();
  await a2.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await a2.end();
}
process.exit(failures ? 1 : 0);
