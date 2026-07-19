// 🛣️ TOLL ENGINE — Firestore/browser side of the offline FASTag
// reconciliation + IOCL toll billing module. All pure parsing/mapping/render
// logic lives in tollParse.ts (unit-tested in Node against the owner's real
// ICICI statement); this file adds file I/O and the database writes.
import {
  collection, doc, getDoc, setDoc, updateDoc, addDoc, getDocs,
  serverTimestamp, increment,
} from 'firebase/firestore';
import { db } from '../firebase';
import { postEntry } from './accounting/journal';
import { getField, toISODate, round2 } from './accounting/tripMath';
import { logAudit } from './audit';
import {
  parseIciciText, rowsToTxns, parseCsvText,
  type TollTxn, type TollMap, type ParsedStatement, type ClaimData,
} from './tollParse';

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
const tollDocId = (txn: TollTxn) =>
  `TFS_${txn.ref_no.replace(/[^A-Za-z0-9]/g, '_').slice(0, 120)}` +
  (/AUTO-/.test(txn.ref_no) ? '' : `_${txn.amount}`);

export interface SaveResult { saved: number; duplicates: number; mapped: number; unmatched: number; }

/** Save mapped tolls to TOLL_TRANSACTIONS (doc id from ref_no — re-uploading
 *  the same statement can never duplicate). New mapped tolls also bump the
 *  trip's toll_amt/total_expense, and one idempotent journal entry posts the
 *  batch under the right company ledger. */
export async function saveTollBatch(maps: TollMap[], opts: { company: string; source_file: string }): Promise<SaveResult> {
  let saved = 0, duplicates = 0, mapped = 0, unmatched = 0, totalNew = 0;
  const tripTotals = new Map<string, number>();
  for (const mp of maps) {
    const id = tollDocId(mp.txn);
    const ref = doc(db, 'TOLL_TRANSACTIONS', id);
    if ((await getDoc(ref)).exists()) { duplicates++; continue; }
    const trip = mp.trip;
    await setDoc(ref, {
      Vehicle_No: mp.txn.vehicle_no,
      Amount: mp.txn.amount,
      Txn_Date: mp.txn.txn_date,
      txn_datetime: mp.txn.txn_datetime,
      Toll_Plaza_Name: mp.txn.plaza,
      lane_id: mp.txn.lane,
      Transaction_Ref: mp.txn.ref_no,
      tag_account: mp.txn.tag_account,
      linked_trip_id: trip ? String(getField(trip, ['trip_id', 'Trip_ID']) || trip.id) : 'UNMAPPED',
      trip_db_id: trip?.id || '',
      linked_customer: trip ? String(getField(trip, ['customer_name', 'Customer', 'Registered_Assessee']) || '') : '',
      invoice_no: trip ? String(getField(trip, ['challan_no', 'Challan_No', 'invoice_no']) || '') : '',
      invoice_date: trip ? toISODate(getField(trip, ['loading_date', 'Loading_Date', 'start_date'])) : '',
      loading_loc: trip ? String(getField(trip, ['loading_point', 'Loading_Point']) || '') : '',
      dest_loc: trip ? String(getField(trip, ['consignee_name', 'Consignee_Name', 'unloading_point']) || '') : '',
      // Blank company kabhi save nahi hoti — warna company-filtered P&L me toll gayab ho jata.
      company: opts.company || 'PRASAD TRANSPORT',
      map_status: mp.confidence,
      claim_status: 'UNCLAIMED',
      billing_type: 'Reimbursable (Bill to Co.)',
      is_billable: true,
      source: 'fastag_statement',
      source_file: opts.source_file,
      createdAt: serverTimestamp(),
    });
    saved++; totalNew += mp.txn.amount;
    if (trip) { mapped++; tripTotals.set(trip.id, (tripTotals.get(trip.id) || 0) + mp.txn.amount); }
    else unmatched++;
  }
  // Trip P&L: bump toll figures for newly saved txns only.
  for (const [tripId, amt] of tripTotals) {
    await updateDoc(doc(db, 'TRIPS', tripId), { toll_amt: increment(round2(amt)), total_expense: increment(round2(amt)) }).catch(() => {});
  }
  // Journal (idempotent per statement file + company).
  if (totalNew > 0) {
    await postEntry({
      source_type: 'TOLL_STATEMENT',
      source_ref: `${opts.company || 'FLEET'}__${opts.source_file}`.slice(0, 200),
      date: new Date().toISOString().slice(0, 10),
      narration: `FASTag statement ${opts.source_file} — ${saved} tolls (${opts.company || 'fleet'})`,
      company: opts.company || '',
      lines: [
        { ledger: 'Toll & Fastag Expense', dr_cr: 'Dr', amount: round2(totalNew) },
        { ledger: 'Fastag Wallet / Bank', dr_cr: 'Cr', amount: round2(totalNew) },
      ],
    }).catch(() => {});
  }
  logAudit({ action: 'FASTAG_STATEMENT_SYNC', target: opts.source_file, details: `${saved} new (${mapped} mapped), ${duplicates} dup — ${opts.company}` });
  return { saved, duplicates, mapped, unmatched };
}

// ── Claim persistence ────────────────────────────────────────────────────
/** Persist the claim + mark its toll txns CLAIMED (so they never bill twice). */
export async function saveClaim(c: ClaimData, tollDocIds: string[]): Promise<string> {
  const ref = await addDoc(collection(db, 'TOLL_CLAIMS'), {
    ...c, txn_count: tollDocIds.length, status: 'SUBMITTED', created_at: serverTimestamp(),
    groups: c.groups.map(g => ({ ...g, txns: g.txns.map(t => t.id) })), // store ids, not docs
  });
  for (const id of tollDocIds) {
    await updateDoc(doc(db, 'TOLL_TRANSACTIONS', id), { claim_status: 'CLAIMED', claim_no: c.claim_no }).catch(() => {});
  }
  logAudit({ action: 'TOLL_CLAIM_GENERATED', target: c.claim_no, details: `${c.vendor_name} → ${c.plant_name} ₹${c.total} (${tollDocIds.length} tolls)` });
  return ref.id;
}

/** Claims filed in the claim month (for sequence numbering). */
export async function nextClaimSeq(dateISO: string): Promise<number> {
  try {
    const snap = await getDocs(collection(db, 'TOLL_CLAIMS'));
    const mm = dateISO.slice(0, 7);
    return snap.docs.filter(d => String(d.data().claim_date || '').startsWith(mm)).length + 1;
  } catch { return 1; }
}
