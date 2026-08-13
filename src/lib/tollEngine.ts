// 🛣️ TOLL ENGINE — browser side of the FASTag reconciliation + IOCL toll
// billing module. Live PostgreSQL (/api/v1/toll).
//
// All pure parsing/mapping/render logic still lives in tollParse.ts, unit-tested
// in Node against the owner's real ICICI statement. Only PERSISTENCE moved.
//
// THIS FILE WAS HALF OF A DUAL WRITER. `toll-sync.cjs` writes the same tolls
// from the server using the same dedup identity, and until now the two wrote to
// different databases — a toll present in only one gets billed twice or never.
// Both now go through the same table, and the dedup key is enforced BY the
// database (`toll_txn_ext_uniq`) rather than by each writer checking first.
import { getField, toISODate, round2 } from './accounting/tripMath';
import { logAudit } from './audit';
import {
  parseIciciText, rowsToTxns, parseCsvText,
  type TollTxn, type TollMap, type ParsedStatement, type ClaimData,
} from './tollParse';

const API = (import.meta as any).env?.VITE_AGENT_API_URL || 'http://127.0.0.1:3300';
const TOLL = `${API}/api/v1/toll`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};
const post = (url: string, body: any): Promise<any> => fetchJson(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export * from './tollParse';

// ── File input: PDF (pdf.js) / CSV / Excel (SheetJS, lazy) ───────────────
async function pdfAllText(file: File): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  let out = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    out += tc.items.map((it: any) => it.str).join(' ') + '\n';
  }
  return out;
}

/** Entry point: parse any FASTag statement file (PDF / CSV / XLSX / XLS). */
export async function parseFastagStatement(file: File): Promise<ParsedStatement> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    return parseIciciText(await pdfAllText(file));
  }
  let rows: any[][];
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const XLSX: any = await import('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
  } else {
    rows = parseCsvText(await file.text());
  }
  const { txns, skipped } = rowsToTxns(rows);
  return { company: '', bank: '', period_from: '', period_to: '', txns, skipped };
}

// ── Idempotent batch save (multi-company) ────────────────────────────────
// Dedup identity: API providers (GTROPY etc.) carry a globally-unique
// ext_txn_id — that is THE key. Statement/portal rows fall back to the legacy
// ref_no(+amount) scheme. MUST stay identical to tollDocId in toll-sync.cjs.
const tollDocId = (txn: TollTxn) =>
  txn.ext_txn_id
    ? `TFX_${String(txn.ext_txn_id).replace(/[^A-Za-z0-9]/g, '_').slice(0, 160)}`
    : `TFS_${txn.ref_no.replace(/[^A-Za-z0-9]/g, '_').slice(0, 120)}` +
      (/AUTO-/.test(txn.ref_no) ? '' : `_${txn.amount}`);

export interface SaveResult { saved: number; duplicates: number; mapped: number; unmatched: number; }

/** Save mapped tolls. Idempotence is the database's job now: `ext_txn_id` is
 *  UNIQUE, so re-uploading the same statement inserts nothing and reports the
 *  rows it skipped. The old version read every doc back to check first, which
 *  is both slower and racy against the runner doing the same thing.
 *
 *  The dedup identity is unchanged and still has to match toll-sync.cjs: an
 *  API provider's globally-unique ext_txn_id when present, otherwise the legacy
 *  ref_no(+amount) scheme. */
export async function saveTollBatch(maps: TollMap[], opts: { company: string; source_file: string }): Promise<SaveResult> {
  const rows = maps.map((mp) => {
    const trip = mp.trip;
    return {
      // tollDocId() is the ONE definition of this rule on the browser side and
      // must stay byte-identical to tollDocId in toll-sync.cjs — that shared
      // key is what makes the two writers converge instead of duplicating.
      ext_txn_id: tollDocId(mp.txn),
      vehicle_no: mp.txn.vehicle_no,
      amount: mp.txn.amount,
      txn_date: toISODate(mp.txn.txn_date) || mp.txn.txn_date,
      txn_datetime: mp.txn.txn_datetime || null,
      plaza_name: mp.txn.plaza || null,
      txn_ref: mp.txn.ref_no || null,
      tag_id: mp.txn.tag_account || null,
      trip_id: trip?.id || null,
      invoice_no: trip ? String(getField(trip, ['challan_no', 'Challan_No', 'invoice_no']) || '') : null,
      invoice_date: trip ? (toISODate(getField(trip, ['loading_date', 'Loading_Date', 'start_date'])) || null) : null,
      loading_loc: trip ? String(getField(trip, ['loading_point', 'Loading_Point']) || '') : null,
      dest_loc: trip ? String(getField(trip, ['consignee_name', 'Consignee_Name', 'unloading_point']) || '') : null,
      // Blank company is never saved — a company-filtered P&L would lose the toll.
      company: opts.company || 'PRASAD TRANSPORT',
      claim_status: 'UNCLAIMED',
      billing_type: 'Reimbursable (Bill to Co.)',
      is_billable: true,
      provider: 'fastag_statement',
      remarks: opts.source_file,
    };
  });

  const j = await post(`${TOLL}/transactions/import`, { transactions: rows });
  const mapped = maps.filter((m) => m.trip).length;
  logAudit({
    action: 'FASTAG_STATEMENT_SYNC', target: opts.source_file,
    details: `${j.inserted} new (${mapped} mapped), ${j.skipped_already_present} dup — ${opts.company}`,
  });
  return {
    saved: j.inserted ?? 0,
    duplicates: j.skipped_already_present ?? 0,
    mapped,
    unmatched: maps.length - mapped,
  };
}

/** File a claim. The API stamps the tolls and writes the claim in ONE
 *  transaction, so two operators generating the same fortnight cannot both
 *  bill the same toll — the second is told how many were already claimed
 *  instead of silently double-billing. */
export async function saveClaim(c: ClaimData, tollIds: string[]): Promise<string> {
  const j = await post(`${TOLL}/claims`, {
    claim_no: c.claim_no,
    claim_date: c.claim_date,
    vendor_name: c.vendor_name,
    vendor_code: c.vendor_code || null,
    plant_name: c.plant_name || null,
    plant_code: c.plant_code || null,
    period_from: c.period_from,
    period_to: c.period_to,
    fortnight_label: c.fortnight_label || null,
    groups: (c.groups ?? []).map((g: any) => ({ ...g, txns: g.txns.map((t: any) => t.id ?? t) })),
    toll_ids: tollIds,
  });
  logAudit({
    action: 'TOLL_CLAIM_GENERATED', target: c.claim_no,
    details: `${c.vendor_name} → ${c.plant_name} ₹${j.total} (${j.tolls_claimed} tolls${j.skipped_already_claimed ? `, ${j.skipped_already_claimed} already billed` : ''})`,
  });
  if (j.skipped_already_claimed > 0) {
    // Surfaced, not swallowed: the printed claim the operator is holding covers
    // fewer tolls than the screen listed, and they need to know before filing.
    alert(`⚠️ ${j.skipped_already_claimed} toll(s) is claim me nahi aaye — woh pehle hi bill ho chuke the.\n\nClaim ${c.claim_no} me ${j.tolls_claimed} toll hain, total ₹${j.total}.`);
  }
  return j.claim.id;
}

/** Claims filed in the claim month, for sequence numbering. The UNIQUE on
 *  claim_no is the real guard against a collision; this just keeps the common
 *  case from colliding in the first place. */
export async function nextClaimSeq(dateISO: string): Promise<number> {
  try {
    const j = await fetchJson(`${TOLL}/claims/next-seq?date=${encodeURIComponent(dateISO)}`);
    return j.next_seq ?? 1;
  } catch { return 1; }
}
