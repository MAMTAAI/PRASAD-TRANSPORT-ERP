// server/lib/nightlyFuelSync.js
// ─────────────────────────────────────────────────────────────────────────────
// The 02:00 IST chain. KAMALA wakes it; four stages run under four agents.
//
//   collect    AGENT_04 BHUVANESHWARI  find the statements that arrived
//   import     AGENT_06 CHHINNAMASTA   parse and store every row
//   reconcile  AGENT_06 CHHINNAMASTA   swipes vs the fuel register, per fortnight
//   handoff    AGENT_00 KAMALA         tell CHHINNAMASTA; TARA posts, not this
//
// WHY THIS DOES NOT LOG INTO A PORTAL. The ask was "log into IOCL, HPCL and
// BPCL with stored credentials". HPCL DriveTrack puts a captcha on every login
// — a deliberate "a person must do this" — and keeping live passwords to three
// fuel-credit accounts in this database is a worse risk than the download it
// saves. So the statements ARRIVE instead: dropped in a watched folder, or
// mailed by the provider (BPCL's own dialog offers "Send Excel(.csv) via
// Email"). Nobody logs in at 02:00 and no portal password is stored. See
// migration 151.
//
// WHY IT DOES NOT POST TO THE LEDGER. CHHINNAMASTA's own declaration forbids
// it: "post the fuel expense to the ledger itself — it emits fuel.slip.recorded,
// TARA posts". A nightly job that quietly posted money would be the one part of
// this system nobody reviewed. It emits; TARA decides.
//
// EVERY STAGE IS SAFE TO REPEAT. A stage that fails does not roll back the one
// before it — the import is worth keeping even if reconciliation then falls
// over — and tomorrow's run re-reads the same folder and converges.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import path from 'node:path';
import { query, isDegraded } from '../db/pool.js';
import { periodBounds } from './periods.js';
import { ingestFleetCardCsv, IngestError } from './fleetCardIngest.js';
import { startRun, startStep, finishRun, reapStaleRuns, istDate } from './agentLog.js';
import { emit } from '../agents/bus.js';

export const JOB = 'nightly_fuel_sync';

/** Files bigger than this are not statements. Guards a folder someone parks a backup in. */
const MAX_FILE_BYTES = 40 * 1024 * 1024;

/** `*.csv` and friends, as a matcher. Deliberately tiny — no glob dependency. */
export function globToRe(glob) {
  const esc = String(glob || '*.csv').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

/**
 * "Now", as the office reads a clock — safe to hand to periodBounds().
 *
 * NOT `new Date(t + 5.5h)`. periodBounds() reads the date with getDate(), which
 * is LOCAL, so adding five and a half hours to the instant is only right on a
 * box that happens to run UTC. Production does; this office PC runs IST, and
 * there the shift lands twice: at 20:00 on the 15th it reports the 16th, and
 * the fortnight flips to 16–30 while the office is still inside 1–15. That is a
 * whole half-month of card swipes reconciled against the wrong cycle.
 *
 * So: take the IST wall-clock date, then rebuild it as a LOCAL date at midday,
 * where the local getters read back exactly the day IST is on — whatever zone
 * the box keeps.
 */
export function istNow(d = new Date()) {
  const [y, m, day] = new Date(d.getTime() + 5.5 * 3600_000)
    .toISOString().slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day, 12, 0, 0);
}

// ── STAGE 1 · BHUVANESHWARI — what arrived ─────────────────────────────────
export async function collectStatements({ log = console } = {}) {
  const { rows: sources } = await query(
    `SELECT s.id, s.account_id, s.kind, s.locator, s.file_glob, s.account_no, s.notes,
            a.provider, a.account_no AS acct_no
       FROM fleet_card_sources s
       LEFT JOIN fleet_card_accounts a ON a.id = s.account_id
      WHERE s.active
      ORDER BY s.kind, s.locator`);

  const files = [];
  const skipped = [];

  for (const s of sources) {
    if (s.kind === 'EMAIL') {
      // Declared, not yet fetched. There is no IMAP client in this codebase —
      // mailChannel.js sends, it does not read — so saying "EMAIL" here would
      // be a lie by omission. It is listed as a source so the plumbing is one
      // library away, and reported every night so it cannot be forgotten.
      skipped.push({ source_id: s.id, locator: s.locator,
        reason: 'EMAIL sources need an IMAP reader; none is installed yet' });
      continue;
    }

    let names;
    try {
      names = await fs.readdir(s.locator);
    } catch (err) {
      // A folder that vanished is a finding, not a crash. The other sources
      // still run — one unplugged drive must not cost the whole night.
      skipped.push({ source_id: s.id, locator: s.locator,
        reason: `cannot read folder: ${err.code ?? err.message}` });
      continue;
    }

    const re = globToRe(s.file_glob);
    for (const name of names) {
      if (!re.test(name)) continue;
      const full = path.join(s.locator, name);
      let st;
      try { st = await fs.stat(full); } catch { continue; }
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) {
        skipped.push({ source_id: s.id, file: name, reason: `too large (${st.size} bytes)` });
        continue;
      }
      // A file too small to be a statement is either a download still being
      // written or one that was truncated. Skipping it is right; skipping it
      // SILENTLY is not — a truncated export would then vanish every night
      // with nothing to show for it. It is reported like any other finding.
      if (st.size < 40) {
        skipped.push({ source_id: s.id, file: name,
          reason: `only ${st.size} bytes — still downloading, or truncated` });
        continue;
      }
      files.push({
        source_id: s.id, account_id: s.account_id, account_no: s.account_no ?? s.acct_no,
        provider_hint: s.provider ?? null, file: name, full, size: st.size,
        mtime: st.mtime.toISOString(),
      });
    }
    await query(`UPDATE fleet_card_sources SET last_seen_at = now() WHERE id = $1::uuid`, [s.id])
      .catch(() => {});
  }

  // Oldest first, so a fortnight lands in the order it was exported.
  files.sort((a, b) => a.mtime.localeCompare(b.mtime));
  log.debug?.({ sources: sources.length, files: files.length }, '[nightly] collected');
  return { sources: sources.length, files, skipped };
}

// ── STAGE 2 · CHHINNAMASTA — store what arrived ────────────────────────────
export async function importStatements(files, { run_id = null, log = console } = {}) {
  const results = [];
  let rows_new = 0;
  let rows_read = 0;
  const accounts = new Set();

  for (const f of files) {
    let csv;
    try {
      csv = await fs.readFile(f.full, 'utf8');
    } catch (err) {
      results.push({ file: f.file, ok: false, error: `unreadable: ${err.message}` });
      continue;
    }
    try {
      const r = await ingestFleetCardCsv({
        csv, source_file: f.file, account_no: f.account_no,
        created_by: 'AGENT_06 CHHINNAMASTA', source_id: f.source_id, run_id,
      });
      rows_new += r.rows_new ?? 0;
      rows_read += r.rows_read ?? 0;
      if (r.account_id) accounts.add(r.account_id);
      results.push({ file: f.file, ok: true, ...r, position: undefined });
    } catch (err) {
      // ONE BAD FILE IS NOT A BAD NIGHT. An HPCL export we have no parser for
      // sits in the same folder as the IOCL one that imports cleanly; refusing
      // the whole run over it would mean the fleet card never updates.
      const code = err instanceof IngestError ? err.code : 'IMPORT_FAILED';
      results.push({ file: f.file, ok: false, error_code: code, error: err.message });
      log.warn?.({ file: f.file, code, err: err.message }, '[nightly] file refused');
    }
  }
  return { results, rows_new, rows_read, account_ids: [...accounts],
           files_ok: results.filter(r => r.ok).length,
           files_failed: results.filter(r => !r.ok).length };
}

// ── STAGE 3 · CHHINNAMASTA — does the card agree with the register? ────────
export async function reconcileFortnight({ accountIds = null, offset = 0, now = new Date() } = {}) {
  // The fortnight as the oil company bills it: 1–15, 16–end. Computed on IST,
  // explicitly — at 02:00 IST the box's own clock is still on yesterday, and
  // on the 16th that would silently reconcile the wrong half-month.
  const cycle = periodBounds('FORTNIGHT', offset, istNow(now));

  const params = [cycle.from, cycle.to];
  let scope = '';
  if (accountIds?.length) { params.push(accountIds); scope = 'AND m.account_id = ANY($3::uuid[])'; }

  const { rows } = await query(`
    SELECT m.account_id,
           m.provider,
           count(*)                                            AS swipes,
           count(*) FILTER (WHERE m.milan = 'MATCHED')          AS matched,
           count(*) FILTER (WHERE m.milan = 'AMBIGUOUS')        AS ambiguous,
           count(*) FILTER (WHERE m.milan = 'NO_MEMO')          AS no_memo,
           count(*) FILTER (WHERE m.milan = 'NO_VEHICLE')       AS no_vehicle,
           COALESCE(sum(m.amount), 0)::numeric(16,2)            AS card_amount,
           COALESCE(sum(m.quantity), 0)::numeric(16,3)          AS card_litres,
           COALESCE(sum(m.amount) FILTER (WHERE m.milan = 'NO_MEMO'), 0)::numeric(16,2)
                                                                AS unaccounted_amount
      FROM v_fleet_card_fuel_match m
     WHERE m.txn_date BETWEEN $1::date AND $2::date ${scope}
     GROUP BY m.account_id, m.provider
     ORDER BY m.provider`, params);

  const total = rows.reduce((a, r) => ({
    swipes: a.swipes + Number(r.swipes),
    matched: a.matched + Number(r.matched),
    ambiguous: a.ambiguous + Number(r.ambiguous),
    no_memo: a.no_memo + Number(r.no_memo),
    no_vehicle: a.no_vehicle + Number(r.no_vehicle),
    card_amount: a.card_amount + Number(r.card_amount),
    unaccounted_amount: a.unaccounted_amount + Number(r.unaccounted_amount),
  }), { swipes: 0, matched: 0, ambiguous: 0, no_memo: 0, no_vehicle: 0,
        card_amount: 0, unaccounted_amount: 0 });

  return { cycle: { from: cycle.from, to: cycle.to, label: cycle.label, short: cycle.short },
           per_account: rows, total };
}

// ── STAGE 4 · hand the night to the agents that own the money ──────────────
//
// This emits. It does not post, and it does not write a ledger row. Each event
// is one account's statement being on the table; CHHINNAMASTA reacts to
// pump.statement.received under its own guards, and what reaches the ledger
// reaches it through TARA, reviewed like everything else.
export async function handOff({ accountIds = [], reconciliation, correlation_id = null }) {
  const emitted = [];
  for (const account_id of accountIds) {
    try {
      const per = reconciliation?.per_account?.find(r => r.account_id === account_id) ?? null;
      await emit('pump.statement.received', {
        aggregate: 'fleet_card_account',
        aggregateId: account_id,
        // NOT 'AGENT_06'. CHHINNAMASTA *subscribes* to this event; it does not
        // declare it in `emits`, and the registry lists it under
        // externalOrigins — events the system raises from outside the swarm,
        // which a scheduled job is. Stamping an agent id here would read as
        // "CHHINNAMASTA emitted this", and would throw outright the day anyone
        // routes it through agentEmit(). NULL is what this column means by
        // external; the trail lives in payload.source and correlation_id.
        emittedBy: null,
        correlationId: correlation_id,
        payload: {
          source: 'nightly_fuel_sync',
          cycle: reconciliation?.cycle ?? null,
          swipes: per ? Number(per.swipes) : null,
          matched: per ? Number(per.matched) : null,
          unaccounted_amount: per ? Number(per.unaccounted_amount) : null,
        },
      });
      emitted.push(account_id);
    } catch (err) {
      // An event that would not go out is reported, not retried in a loop. The
      // rows are already in the database; nothing is lost by telling a person.
      emitted.push({ account_id, error: err.message });
    }
  }
  return { emitted: emitted.length, accounts: emitted };
}

// ── The run ────────────────────────────────────────────────────────────────
/**
 * @param {object}  o
 * @param {'SCHEDULE'|'MANUAL'|'CATCHUP'} o.trigger  SCHEDULE claims the day
 * @param {boolean} o.force  run even if today is already claimed (manual only)
 */
export async function runNightlyFuelSync({ trigger = 'SCHEDULE', force = false, log = console } = {}) {
  if (isDegraded()) return { skipped: 'db unavailable' };

  // A run left RUNNING by a killed process would hold today's claim forever.
  await reapStaleRuns(JOB);

  const claim = await startRun(JOB, {
    trigger: force ? 'MANUAL' : trigger,
    detail: { requested_at: new Date().toISOString(), ist_date: istDate() },
  });
  if (!claim.claimed) return { skipped: claim.reason ?? 'not claimed' };

  const { run_id, correlation_id } = claim;
  const trail = [];
  let status = 'OK';
  let counts = {};

  try {
    // 1 ─ collect
    const s1 = await startStep(run_id, 'collect', { agent_id: 'AGENT_04', agent_code: 'BHUVANESHWARI' });
    const found = await collectStatements({ log });
    trail.push(await s1(found.files.length ? 'OK' : 'SKIPPED', {
      counts: { sources: found.sources, files: found.files.length, skipped: found.skipped.length },
      detail: { files: found.files.map(f => f.file), skipped: found.skipped },
      reason: found.files.length ? null
        : (found.sources ? 'no new statement in any watched source'
                         : 'no fleet-card source is configured yet'),
    }));

    // 2 ─ import
    const s2 = await startStep(run_id, 'import', { agent_id: 'AGENT_06', agent_code: 'CHHINNAMASTA' });
    const imported = found.files.length
      ? await importStatements(found.files, { run_id, log })
      : { results: [], rows_new: 0, rows_read: 0, account_ids: [], files_ok: 0, files_failed: 0 };
    trail.push(await s2(
      imported.files_failed && !imported.files_ok ? 'FAILED'
        : found.files.length ? 'OK' : 'SKIPPED', {
      counts: { files_ok: imported.files_ok, files_failed: imported.files_failed,
                rows_read: imported.rows_read, rows_new: imported.rows_new },
      detail: { files: imported.results },
      reason: found.files.length ? null : 'nothing to import',
    }));

    // 3 ─ reconcile. Runs even when nothing new arrived: the fortnight's
    //     standing is what the desk reads in the morning, and it changes when
    //     a fuel memo is entered, not only when a statement lands.
    const s3 = await startStep(run_id, 'reconcile', { agent_id: 'AGENT_06', agent_code: 'CHHINNAMASTA' });
    const rec = await reconcileFortnight({
      accountIds: imported.account_ids.length ? imported.account_ids : null,
    });
    trail.push(await s3('OK', {
      counts: rec.total,
      detail: { cycle: rec.cycle, per_account: rec.per_account },
    }));

    // 4 ─ hand off
    // KAMALA's own stage. Its mandate is to decide what runs and then delegate;
    // handing the night to the agent that owns fuel is exactly that, and the
    // three stages above are the ones that did domain work.
    const s4 = await startStep(run_id, 'handoff', { agent_id: 'AGENT_00', agent_code: 'KAMALA' });
    const off = imported.account_ids.length
      ? await handOff({ accountIds: imported.account_ids, reconciliation: rec, correlation_id })
      : { emitted: 0, accounts: [] };
    trail.push(await s4(off.emitted ? 'OK' : 'SKIPPED', {
      counts: { events: off.emitted },
      detail: { to: 'AGENT_06 CHHINNAMASTA (which posts through AGENT_02 TARA)',
                accounts: off.accounts },
      reason: off.emitted ? null : 'no account received new rows tonight',
    }));

    counts = {
      files: found.files.length,
      files_failed: imported.files_failed,
      rows_new: imported.rows_new,
      swipes: rec.total.swipes,
      matched: rec.total.matched,
      needs_attention: rec.total.no_memo + rec.total.ambiguous + rec.total.no_vehicle,
      unaccounted_amount: rec.total.unaccounted_amount,
      events: off.emitted,
    };
    if (imported.files_failed) status = 'FAILED';   // the night ran; a file did not

    await finishRun(run_id, status, {
      counts,
      reason: imported.files_failed
        ? `${imported.files_failed} file(s) refused — see the import step`
        : null,
    });
    log.info?.({ run_id, ...counts }, '[nightly] fuel sync finished');
    return { run_id, status, counts, cycle: rec.cycle, trail };
  } catch (err) {
    await finishRun(run_id, 'FAILED', { counts, error: err.message });
    log.error?.({ run_id, err: err.message }, '[nightly] fuel sync failed');
    return { run_id, status: 'FAILED', error: err.message, counts, trail };
  }
}
