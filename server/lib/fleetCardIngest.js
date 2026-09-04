// server/lib/fleetCardIngest.js
// ─────────────────────────────────────────────────────────────────────────────
// One way to take a fleet-card statement into the database.
//
// This used to live inside POST /fleet-card/import. The nightly job needs the
// identical behaviour, and two copies of an importer is how a file uploaded by
// hand ends up counted differently from the same file picked up at 02:00. So
// the route and the cron both call this, and there is one place where a money
// row is written.
//
// RE-IMPORTING IS THE NORMAL CASE. The same fortnight sits in five downloads.
// Every insert is ON CONFLICT DO NOTHING on (account, provider txn id, kind),
// so a re-import converges and reports how much it already had.
//
// NOTHING HERE POSTS TO A LEDGER. This stores what the oil company says
// happened. Settling it is a separate, deliberate act — see chhinnamasta.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { parseFleetCardCsv } from './fleetCardImport.js';

/** An error the caller is expected to report verbatim, not swallow. */
export class IngestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const contentSha = (csv) =>
  crypto.createHash('sha256').update(String(csv), 'utf8').digest('hex');

/**
 * Parse one export and store every row it names.
 *
 * @param {object}  o
 * @param {string}  o.csv          the file, as text
 * @param {string?} o.source_file  filename, for the trail
 * @param {string?} o.account_no   when the export does not name its account
 * @param {string?} o.created_by   who or what asked
 * @param {string?} o.source_id    fleet_card_sources row, when automatic
 * @param {string?} o.run_id       agent_execution_logs run, when automatic
 * @returns {Promise<object>} import summary
 * @throws  {IngestError} PARSE_FAILED | NO_ACCOUNT | ACCOUNT_NOT_SET_UP
 */
export async function ingestFleetCardCsv({
  csv, source_file = null, account_no = null, created_by = null,
  source_id = null, run_id = null,
}) {
  let parsed;
  try {
    parsed = parseFleetCardCsv(csv, { account_no });
  } catch (e) {
    // A file we cannot read is refused with the reason. Guessing at the
    // columns is how wrong money gets imported silently.
    throw new IngestError(e.code ?? 'PARSE_FAILED', e.message, 400);
  }

  const accountNo = parsed.account_no ?? account_no;
  if (!accountNo) {
    throw new IngestError('NO_ACCOUNT',
      'this export does not name its account — pass account_no with the upload', 400);
  }

  const { rows: acc } = await query(
    `SELECT id, operating_company FROM fleet_card_accounts
      WHERE provider = $1 AND account_no = $2`,
    [parsed.provider, String(accountNo).trim()]);
  if (!acc.length) {
    throw new IngestError('ACCOUNT_NOT_SET_UP',
      `${parsed.provider} account ${accountNo} is not connected yet — add it first, `
      + 'so its operating company is decided before any money lands under it', 404);
  }
  const accountId = acc[0].id;
  const sha = contentSha(csv);

  // THE SAME FILE, SEEN AGAIN. A download sitting in the watched folder is
  // there every night for a week. The row-level ON CONFLICT below would make
  // re-reading it harmless but not free — it would re-parse and re-probe every
  // row nightly, and the batch trail would fill with empty imports that hide
  // the real ones. The content hash stops it at the door and says so.
  const { rows: seen } = await query(
    `SELECT id, created_at, rows_new FROM fleet_card_import_batches
      WHERE account_id = $1::uuid AND content_sha = $2`, [accountId, sha]);
  if (seen.length) {
    return {
      imported: false,
      already_imported: true,
      provider: parsed.provider,
      account_no: accountNo,
      account_id: accountId,
      batch_id: seen[0].id,
      first_imported_at: seen[0].created_at,
      rows_read: parsed.rows.length,
      rows_new: 0,
      rows_already_had: parsed.rows.length,
      rows_skipped: 0,
    };
  }

  const out = await withTransaction(async (t) => {
    const { rows: [batch] } = await t.query(`
      INSERT INTO fleet_card_import_batches
        (account_id, provider, source_file, period_from, period_to, rows_read,
         created_by, content_sha, source_id, run_id)
      VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9::uuid,$10::uuid) RETURNING id`,
      [accountId, parsed.provider, source_file, parsed.period_from ?? null,
       parsed.period_to ?? null, parsed.rows.length, created_by, sha,
       source_id, run_id]);

    let fresh = 0;
    let parked = 0;
    for (const r of parsed.rows) {
      if (!r.txn_date || !r.provider_txn_id) { parked += 1; continue; }
      const { rows } = await t.query(`
        INSERT INTO fleet_card_statement_txns
          (account_id, provider, provider_txn_id, txn_date, settlement_date, kind,
           provider_txn_type, direction, card_pan, vehicle_raw, vehicle_no, vehicle_id,
           merchant_name, merchant_code, location, product, quantity, rate, amount, unit,
           balance_after, status, source_doc_no, raw, import_batch_id, source_file)
        SELECT $1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,
               -- The lorry as OUR fleet spells it, matched on the same
               -- normalisation the database uses everywhere else. A
               -- registration the fleet master has never heard of stays NULL
               -- and shows up as a finding rather than a guess.
               v.vehicle_no, v.id,
               $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24
          FROM (SELECT 1) _
          LEFT JOIN LATERAL (
            SELECT id, vehicle_no FROM vehicles
             WHERE reg_key(vehicle_no) = reg_key($10) LIMIT 1) v ON true
        ON CONFLICT (account_id, provider_txn_id, kind) DO NOTHING
        RETURNING id`,
        [accountId, parsed.provider, r.provider_txn_id, r.txn_date, r.settlement_date,
         r.kind, r.provider_txn_type, r.direction, r.card_pan, r.vehicle_raw,
         r.merchant_name, r.merchant_code, r.location, r.product, r.quantity, r.rate,
         r.amount, r.unit ?? 'INR', r.balance_after, r.status, r.source_doc_no,
         JSON.stringify(r.raw ?? {}), batch.id, source_file]);
      if (rows.length) fresh += 1;
    }

    await t.query(
      `UPDATE fleet_card_import_batches
          SET rows_new = $2, rows_seen = $3, rows_parked = $4 WHERE id = $1::uuid`,
      [batch.id, fresh, parsed.rows.length - fresh - parked, parked]);
    return { batch_id: batch.id, fresh, parked };
  });

  const { rows: pos } = await query(
    `SELECT * FROM v_fleet_card_position WHERE account_id = $1::uuid`, [accountId]);

  return {
    imported: true,
    already_imported: false,
    provider: parsed.provider,
    account_no: accountNo,
    account_id: accountId,
    operating_company: acc[0].operating_company,
    batch_id: out.batch_id,
    period: { from: parsed.period_from ?? null, to: parsed.period_to ?? null },
    rows_read: parsed.rows.length,
    rows_new: out.fresh,
    // Said explicitly: a second upload of the same statement is expected and
    // is not an error.
    rows_already_had: parsed.rows.length - out.fresh - out.parked,
    rows_skipped: out.parked,
    position: pos[0] ?? null,
  };
}
