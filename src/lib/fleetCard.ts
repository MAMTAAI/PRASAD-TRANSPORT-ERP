// 💳 Fleet Card engine — statement extraction + swipe reconciliation.
// Business model (ground reality, confirmed by the owner):
//   1. Trucks take fuel on CREDIT at local pumps  -> liability (Creditors: pump) + trip expense
//   2. Pump bill is paid by SWIPING the fleet card -> CARD_SETTLEMENT (Dr Creditors:pump / Cr Fleet Card wallet)
//   3. Companies deduct ~40% advance from freight  -> CARD_RECHARGE (Dr Fleet Card wallet / Cr Debtors:customer)
// The reconciler reads IOCL XTRAPOWER / HPCL DriveTrack Plus / BPCL Hello Fleet
// statements and matches card swipes against our recorded settlements to catch
// missed pump payments or unauthorized swipes.
//
// Extraction is TEXT-FIRST: these statements are digital PDFs with text layers,
// so Gemma reads extracted text (~10x faster than vision). Pages without a text
// layer (scanned/photographed) fall back to vision automatically.
import { llmChat } from './llm';
import { toISODate, round2 } from './accounting/tripMath';

export type CardProvider = 'IOCL' | 'HPCL' | 'BPCL';

export const CARD_PROVIDERS: Record<CardProvider, { name: string; wallet: string; color: string }> = {
  IOCL: { name: 'IOCL XTRAPOWER', wallet: 'Fleet Card: IOCL XTRAPOWER', color: '#f97316' },
  HPCL: { name: 'HPCL DriveTrack Plus', wallet: 'Fleet Card: HPCL DriveTrack', color: '#3b82f6' },
  BPCL: { name: 'BPCL Hello Fleet', wallet: 'Fleet Card: BPCL Hello Fleet', color: '#eab308' },
};

export interface StmtTxn {
  date: string;          // YYYY-MM-DD
  description: string;   // merchant / pump name or narration
  vehicle_no: string;    // cleaned plate ('' when N/A)
  txn_type: 'SWIPE' | 'RECHARGE' | 'OTHER';
  amount: number;
}

export interface CardStatement {
  provider: CardProvider;
  period: string;
  opening_balance: number;
  closing_balance: number;
  total_recharge: number;
  total_sale: number;
  txns: StmtTxn[];
  pages: number;
  warnings: string[];
  balanceChecks: { label: string; ok: boolean; detail: string }[];
}

const num = (v: any): number => {
  const n = parseFloat(String(v ?? '').replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const cleanPlate = (v: any): string => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** IOCL statements use US-style M/D/YYYY dates — normalize BEFORE toISODate
 *  (which assumes DD-MM-YYYY for slashed dates). */
function stmtDate(v: any, provider: CardProvider): string {
  const s = String(v ?? '').trim();
  if (provider === 'IOCL') {
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return toISODate(s);
}

// ── PDF page → text (or image fallback) ──────────────────────────────────

interface PageContent { text: string; b64: string | null; label: string; }

async function pdfToPages(file: File, maxPages: number, onProgress?: (m: string) => void): Promise<PageContent[]> {
  const pdfjs: any = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const n = Math.min(pdf.numPages, maxPages);
  const out: PageContent[] = [];
  for (let i = 1; i <= n; i++) {
    onProgress?.(`Reading ${file.name} — page ${i}/${pdf.numPages}`);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    // Reconstruct lines by y-position so the table structure survives
    const lines: Record<number, any[]> = {};
    for (const it of tc.items) { const y = Math.round(it.transform[5]); (lines[y] ||= []).push(it); }
    const text = Object.keys(lines).map(Number).sort((a, b) => b - a)
      .map(y => lines[y].sort((a, b) => a.transform[4] - b.transform[4]).map((i: any) => i.str).join(' | ').trim())
      .filter(Boolean).join('\n');

    if (text.length > 200) {
      out.push({ text, b64: null, label: `${file.name} p${i}` });
    } else {
      // Scanned page — render for vision
      const raw = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1600 / Math.max(raw.width, raw.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
      out.push({ text: '', b64: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] || '', label: `${file.name} p${i} (scan)` });
    }
  }
  if (pdf.numPages > maxPages) onProgress?.(`⚠️ ${file.name}: ${pdf.numPages} pages — first ${maxPages} read`);
  return out;
}

// ── Extraction ────────────────────────────────────────────────────────────

const STMT_SCHEMA = {
  type: 'object',
  properties: {
    period: { type: 'string' },
    opening_balance: { type: 'string' },
    closing_balance: { type: 'string' },
    total_recharge: { type: 'string' },
    total_sale: { type: 'string' },
    txns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          description: { type: 'string' },
          vehicle_no: { type: 'string' },
          txn_type: { type: 'string', enum: ['SWIPE', 'RECHARGE', 'OTHER'] },
          amount: { type: 'string' },
        },
        required: ['date', 'description', 'vehicle_no', 'txn_type', 'amount'],
      },
    },
  },
  required: ['period', 'opening_balance', 'closing_balance', 'total_recharge', 'total_sale', 'txns'],
};

const PROVIDER_HINTS: Record<CardProvider, string> = {
  IOCL: `This is an IOCL XTRAPOWER fleet-card monthly statement page. Transaction rows carry: Merchant Name (the PETROL PUMP), Location, Vehicle No., Txn Date (M/D/YYYY US format — copy as printed), Txn Type, Amount.
Txn type mapping:
- "CCMS Sale Auth" or "CCMS Sale" (with a real merchant pump + vehicle) => SWIPE (fuel taken/settled at that pump)
- "Recharge" (BILLDESK etc.) => RECHARGE (wallet load)
- "Loyalty Award", "Loyalty Redeem", "CCMS Sale Completion", TDS rows => OTHER
description = the Merchant Name. Summary header: OP. BAL => opening_balance, RECHARGE => total_recharge, use "CCMS Sale Complete" figure for total_sale, CL BALANCE => closing_balance (the CCMS row, not the Loyalty row).`,
  HPCL: `This is an HPCL DriveTrack Plus customer account statement page. The "CCMS Day wise Summary" table rows carry: Date (DD-MM-YYYY), Opening Balance, CCMS Recharge, CCMS Sale (debit), Closing Balance.
For each day row: if CCMS Recharge > 0 emit a RECHARGE txn (amount = recharge); if CCMS Sale > 0 emit a SWIPE txn (amount = the sale figure, description = "CCMS Sale (day total)"). Skip the Total row.
The "Card balances & purchases" table lists per-vehicle totals: emit each as OTHER with vehicle_no and Total Purchase as amount, description "Vehicle month total".
Account Summary: CCMS Opening Balance => opening_balance, CCMS Closing Balance => closing_balance.`,
  BPCL: `This is a BPCL Hello Fleet (SmartFleet) account statement page. Usage Summary row "CMS": Opening Balance => opening_balance, Recharge => total_recharge, Total Sale => total_sale (positive number), Closing Balance => closing_balance.
Transaction/card-level rows: fuel purchases/Ufill at dealers => SWIPE (description = dealer/outlet name, vehicle if shown); wallet loads/recharges => RECHARGE; everything else (rewards, TCS) => OTHER. Dates as printed.`,
};

function pagePrompt(provider: CardProvider): string {
  return `${PROVIDER_HINTS[provider]}
Extract from THIS PAGE ONLY. Empty string for header fields not on this page.
Rules:
- amount and balances: plain numbers, strip commas and ₹ (2,551,063.10 => 2551063.10). Amounts always positive.
- vehicle_no: as printed (dashes OK), or "" when not a vehicle row.
- Do NOT calculate anything. Do NOT invent rows. Skip page headers/footers/column-header lines.`;
}

export async function extractCardStatement(
  file: File,
  provider: CardProvider,
  onProgress?: (m: string) => void
): Promise<CardStatement> {
  const pages = await pdfToPages(file, 20, onProgress);
  if (!pages.length) throw new Error('No readable pages');

  const stmt: CardStatement = {
    provider, period: '', opening_balance: 0, closing_balance: 0,
    total_recharge: 0, total_sale: 0, txns: [], pages: pages.length, warnings: [], balanceChecks: [],
  };

  for (let i = 0; i < pages.length; i++) {
    onProgress?.(`🤖 Mamta AI reading page ${i + 1}/${pages.length}…`);
    const p = pages[i];
    const msg = p.text
      ? { role: 'user' as const, content: `${pagePrompt(provider)}\n\nSTATEMENT PAGE TEXT (columns separated by |):\n${p.text}` }
      : { role: 'user' as const, content: pagePrompt(provider), images: [p.b64!] };
    const res = await llmChat([msg], { format: STMT_SCHEMA, temperature: 0, numCtx: 8192, think: false });

    let parsed: any = {};
    try { parsed = JSON.parse(res.content); }
    catch { try { const m = res.content.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : {}; } catch { parsed = {}; } }

    if (!stmt.period && parsed.period) stmt.period = String(parsed.period).trim();
    if (!stmt.opening_balance && num(parsed.opening_balance)) stmt.opening_balance = round2(num(parsed.opening_balance));
    if (num(parsed.closing_balance)) stmt.closing_balance = round2(num(parsed.closing_balance)); // last page wins
    if (!stmt.total_recharge && num(parsed.total_recharge)) stmt.total_recharge = round2(num(parsed.total_recharge));
    if (!stmt.total_sale && num(parsed.total_sale)) stmt.total_sale = round2(Math.abs(num(parsed.total_sale)));

    for (const t of parsed.txns || []) {
      const amount = round2(Math.abs(num(t.amount)));
      if (amount <= 0) continue;
      const type = ['SWIPE', 'RECHARGE'].includes(String(t.txn_type)) ? t.txn_type : 'OTHER';
      stmt.txns.push({
        date: stmtDate(t.date, provider),
        description: String(t.description ?? '').trim().slice(0, 80),
        vehicle_no: cleanPlate(t.vehicle_no),
        txn_type: type,
        amount,
      });
    }
  }

  // Code-side arithmetic (never trust the model): opening + recharges − sales ≈ closing
  const swipeSum = round2(stmt.txns.filter(t => t.txn_type === 'SWIPE').reduce((s, t) => s + t.amount, 0));
  const rechargeSum = round2(stmt.txns.filter(t => t.txn_type === 'RECHARGE').reduce((s, t) => s + t.amount, 0));
  if (stmt.opening_balance || stmt.closing_balance) {
    const expected = round2(stmt.opening_balance + (stmt.total_recharge || rechargeSum) - (stmt.total_sale || swipeSum));
    const ok = Math.abs(expected - stmt.closing_balance) <= Math.max(10, stmt.closing_balance * 0.01);
    stmt.balanceChecks.push({
      label: 'Opening + Recharge − Sale = Closing',
      ok,
      detail: `${stmt.opening_balance.toLocaleString('en-IN')} + ${(stmt.total_recharge || rechargeSum).toLocaleString('en-IN')} − ${(stmt.total_sale || swipeSum).toLocaleString('en-IN')} = ${expected.toLocaleString('en-IN')} vs stated ${stmt.closing_balance.toLocaleString('en-IN')}`,
    });
    if (!ok) stmt.warnings.push('Statement ka balance math tally nahi hua — pages missing ya rows misread ho sakti hain.');
  }
  if (!stmt.txns.length) stmt.warnings.push('Koi transaction row nahi mili — provider selection check karein.');
  return stmt;
}

// ── Reconciliation ────────────────────────────────────────────────────────

export interface ReconRow {
  stmt: StmtTxn;
  match: { id: string; label: string } | null;
  status: 'MATCHED' | 'MISSING_IN_ERP';
}
export interface ReconResult {
  swipes: ReconRow[];
  recharges: ReconRow[];
  unmatchedErp: { id: string; label: string; amount: number }[]; // we recorded, statement doesn't show
  totals: { swipesMatched: number; swipesMissing: number; missingAmount: number };
}

const dayDiff = (a: string, b: string): number => {
  const ta = new Date(a).getTime(), tb = new Date(b).getTime();
  if (isNaN(ta) || isNaN(tb)) return 99;
  return Math.abs(ta - tb) / 86400000;
};

/** Match statement rows against our CARD_TRANSACTIONS (amount ±₹1, date ±5d,
 *  each ERP txn used at most once — greedy nearest-date). */
export function reconcileStatement(stmt: CardStatement, erpTxns: any[]): ReconResult {
  const pool = erpTxns.map(t => ({
    t, used: false,
    date: toISODate(t.date),
    amount: round2(parseFloat(t.amount) || 0),
    kind: t.type === 'RECHARGE' ? 'RECHARGE' : 'SWIPE', // SETTLEMENT == card swipe at pump
  }));

  const matchOne = (row: StmtTxn, kind: string): ReconRow => {
    const cands = pool
      .filter(p => !p.used && p.kind === kind && Math.abs(p.amount - row.amount) <= 1)
      .map(p => ({ p, dd: row.date && p.date ? dayDiff(row.date, p.date) : 99 }))
      .filter(c => c.dd <= 5)
      .sort((a, b) => a.dd - b.dd);
    if (cands.length) {
      cands[0].p.used = true;
      const t = cands[0].p.t;
      return { stmt: row, match: { id: t.id, label: `${t.party || t.narration || t.type} · ${toISODate(t.date)} · ₹${(parseFloat(t.amount) || 0).toLocaleString('en-IN')}` }, status: 'MATCHED' };
    }
    return { stmt: row, match: null, status: 'MISSING_IN_ERP' };
  };

  const swipes = stmt.txns.filter(t => t.txn_type === 'SWIPE').map(r => matchOne(r, 'SWIPE'));
  const recharges = stmt.txns.filter(t => t.txn_type === 'RECHARGE').map(r => matchOne(r, 'RECHARGE'));
  const unmatchedErp = pool.filter(p => !p.used).map(p => ({
    id: p.t.id,
    label: `${p.t.type === 'RECHARGE' ? '💰 Recharge' : '🤝 Settlement'} · ${p.t.party || ''} · ${p.date}`,
    amount: p.amount,
  }));

  const swipesMissing = swipes.filter(s => s.status === 'MISSING_IN_ERP');
  return {
    swipes, recharges, unmatchedErp,
    totals: {
      swipesMatched: swipes.length - swipesMissing.length,
      swipesMissing: swipesMissing.length,
      missingAmount: round2(swipesMissing.reduce((s, r) => s + r.stmt.amount, 0)),
    },
  };
}
