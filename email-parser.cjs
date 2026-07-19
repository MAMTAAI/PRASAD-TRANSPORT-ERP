#!/usr/bin/env node
/**
 * 📧 EMAIL BILL PARSER — multi-account IMAP auto-fetch + context-aware AI extraction.
 *
 * Flow (every poll cycle):
 *   1. Read EMAIL_SETTINGS/master — Master Switch OFF => sleep (no .env single-account
 *      config anymore; accounts live in Firestore).
 *   2. Query EMAIL_ACCOUNTS where Status == 'Active' (the "Managed Email Accounts"
 *      table in the ERP UI). Each row: email, app_password, imap_host, imap_port,
 *      customer (mapped ERP customer/company).
 *   3. Connect to each account SEQUENTIALLY (safe: per-account try/catch — one dead
 *      mailbox never blocks the rest), fetch UNSEEN mails, download PDF attachments.
 *   4. Send each PDF to Claude (claude-haiku-4-5) WITH the mapped customer's billing
 *      context: their RATE_MASTER rules + customer-master flags. The AI extracts;
 *      arithmetic is then recomputed in code via the bundled freight engine
 *      (resolveTripBilling) — same rules the Monthly Billing screen applies.
 *   5. Insert into EMAIL_PARSED_BILLS (status PENDING_REVIEW — human files it from
 *      the ERP; the parser never writes TRIPS/journal directly). Idempotent per
 *      message+attachment, then marks the mail \Seen.
 *
 * Usage:
 *   node email-parser.cjs           # scheduler: polls every EMAIL_SETTINGS.poll_minutes (default 10)
 *   node email-parser.cjs --once    # single pass (cron / Task Scheduler friendly)
 *
 * Env (.env): ANTHROPIC_API_KEY (required for extraction), ANTHROPIC_MODEL (optional).
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const Anthropic = require('@anthropic-ai/sdk');

// Admin SDK — same pattern as scripts/firestore-backup.cjs (bypasses security rules)
const admin = require(path.join(__dirname, 'whatsapp-server', 'node_modules', 'firebase-admin'));
const serviceAccount = require(path.join(__dirname, 'whatsapp-server', 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const ONCE = process.argv.includes('--once');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── 💰 Freight engine (single source of truth for billing math) ────────────
// Bundle src/lib/freightEngine.ts to CJS exactly like scripts/freight-engine-test.cjs
// does — so the parser applies the SAME RATE_MASTER/RTKM rules as the billing UI.
let F = null;
try {
  const OUT = path.join(__dirname, 'node_modules', '.cache', 'freightEngine.parser.cjs');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execSync(`npx esbuild src/lib/freightEngine.ts --bundle --platform=node --format=cjs --outfile="${OUT}"`, { cwd: __dirname, stdio: 'pipe' });
  F = require(OUT);
} catch (e) {
  log('⚠️ freight engine bundle failed — freight auto-compute off:', e.message.slice(0, 120));
}

// ── Extraction schema (strict — Anthropic structured outputs) ──────────────
const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bill_no: { type: 'string' },
    bill_date: { type: 'string', description: 'YYYY-MM-DD' },
    party_name: { type: 'string' },
    total_amount: { type: 'string' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          vehicle_no: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          loading_point: { type: 'string' },
          destination: { type: 'string' },
          qty: { type: 'string', description: 'quantity with unit as printed, e.g. "17.660 TO" or "20 KL"' },
          rate: { type: 'string' },
          rtd_km: { type: 'string' },
          gross_amount: { type: 'string' },
          ref_no: { type: 'string' },
        },
        required: ['vehicle_no', 'date', 'loading_point', 'destination', 'qty', 'rate', 'rtd_km', 'gross_amount', 'ref_no'],
      },
    },
  },
  required: ['bill_no', 'bill_date', 'party_name', 'total_amount', 'rows'],
};

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[₹,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── 🧠 Customer billing context (per mapped customer, cached per cycle) ────
// This is what makes extraction CONTEXT-AWARE: Claude sees the customer's actual
// configured rules, so it reads the right columns (tonne-km vs per-KL vs fixed).
async function loadCustomerContext(customerName) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const [custSnap, rmSnap, rtkmSnap] = await Promise.all([
    db.collection('CUSTOMERS').get(),
    db.collection('RATE_MASTER').get(),
    db.collection('RTKM_MASTER').get(),
  ]);
  const cust = custSnap.docs.map(d => d.data()).find(c => norm(c.customer_name) === norm(customerName)) || {};
  const rates = rmSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(r => norm(r.Customer) === norm(customerName) && String(r.Status || 'Active') !== 'Inactive');
  const routes = rtkmSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const ruleLines = rates.map(r =>
    `- ${r.Source} -> ${r.Destination}: ${r.Calc_Type} @ ₹${r.Rate_Value}` +
    (r.RTKM_Distance > 0 ? ` (RTKM ${r.RTKM_Distance} km)` : '') +
    ` [${r.Effective_From} to ${r.Effective_To || 'open'}]`
  ).join('\n');

  const promptContext = `BILLING CONTEXT for customer "${customerName}":
- Billing cycle: ${cust.billing_cycle === '15_days' ? 'fortnightly (15 days)' : 'monthly (30 days)'}
- Detention billing: ${cust.detention_applicable ? 'applicable' : 'not applicable'}
${ruleLines ? `- Configured rate rules (RATE MASTER):\n${ruleLines}` : '- No RATE_MASTER rules configured — extract rates exactly as printed.'}
Rows in the bill should correspond to trips for this customer. Quantity units: TO = tonnes, KL = kilolitres.`;

  return { cust, rates, routes, promptContext };
}

// ── Claude extraction (PDF document block + customer context) ──────────────
async function extractPdf(pdfBuffer, filename, ctx) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY not set — cannot extract');
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8192,
    temperature: 0,
    system: 'You extract structured data from Indian transport/freight bills for an ERP. Copy printed values exactly; never calculate; never invent rows. Rows without a vehicle number (subtotals/totals) are skipped. Strip ₹ signs and Indian commas from numbers. Dates as YYYY-MM-DD.',
    output_config: { format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: `${ctx.promptContext}\n\nExtract the bill header and EVERY table row from this bill (file: ${filename}).` },
      ],
    }],
  });
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined the document (safety refusal)');
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { parsed: JSON.parse(text), usage: msg.usage, model: msg.model };
}

/** Recompute each row's freight in CODE with the customer's configured rules. */
function applyBillingRules(rows, customerName, ctx) {
  return rows.map(raw => {
    const qtyNum = num(raw.qty);
    const isKl = /kl/i.test(String(raw.qty));
    const row = {
      vehicle_no: String(raw.vehicle_no || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
      date: String(raw.date || '').slice(0, 10),
      loading_point: String(raw.loading_point || '').trim(),
      destination: String(raw.destination || '').trim(),
      qty: qtyNum, qty_unit: isKl ? 'KL' : /to|mt|ton/i.test(String(raw.qty)) ? 'TO' : '',
      rate_printed: num(raw.rate), rtd_km: num(raw.rtd_km),
      gross_printed: num(raw.gross_amount), ref_no: String(raw.ref_no || '').trim(),
      engine_freight: 0, engine_source: '', freight_matches: null,
    };
    if (F && row.date) {
      const trip = { customer_name: customerName, loading_point: row.loading_point, consignee_name: row.destination };
      const meta = F.resolveTripBilling(ctx.rates, ctx.routes, trip, row.date);
      if (meta && meta.rate > 0) {
        row.engine_freight = F.computeFreight(meta.billing_type, { qty: row.qty, rate: meta.rate, rtkm: meta.rtkm, capacityKl: meta.capacityKl });
        row.engine_source = `${meta.engine}:${meta.calc_type || meta.billing_type}@${meta.rate}`;
        // ±0.5% tolerance — a mismatch flags the row for human review in the ERP
        row.freight_matches = row.gross_printed > 0 ? Math.abs(row.engine_freight - row.gross_printed) <= Math.max(1, row.gross_printed * 0.005) : null;
      }
    }
    return row;
  });
}

// ── Per-account IMAP processing ─────────────────────────────────────────────
async function processAccount(acc) {
  const label = `${acc.email} → ${acc.customer || '(no customer)'}`;
  log(`📬 ${label}: connecting ${acc.imap_host}:${acc.imap_port}…`);
  const client = new ImapFlow({
    host: acc.imap_host,
    port: Number(acc.imap_port) || 993,
    secure: (Number(acc.imap_port) || 993) === 993,
    auth: { user: acc.email, pass: acc.app_password },
    logger: false,
  });
  const stats = { mails: 0, pdfs: 0, parsed: 0, skipped: 0, errors: [] };
  const ctx = await loadCustomerContext(acc.customer);

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const unseen = await client.search({ seen: false });
    for (const uid of unseen || []) {
      stats.mails++;
      let fullyParsed = true;
      try {
        const { content } = await client.download(String(uid));
        const mail = await simpleParser(content);
        const pdfs = (mail.attachments || []).filter(a => /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.filename || ''));
        for (const att of pdfs) {
          stats.pdfs++;
          // Idempotency: doc id from message-id + filename — re-runs never duplicate
          const docId = crypto.createHash('sha1').update(`${mail.messageId || uid}::${att.filename}`).digest('hex');
          const ref = db.collection('EMAIL_PARSED_BILLS').doc(docId);
          if ((await ref.get()).exists) { stats.skipped++; continue; }

          const { parsed, usage, model } = await extractPdf(att.content, att.filename || 'bill.pdf', ctx);
          const rows = applyBillingRules(parsed.rows || [], acc.customer, ctx);
          await ref.set({
            source_email: acc.email,
            customer: acc.customer || '',
            mail_subject: mail.subject || '', mail_from: mail.from?.text || '',
            mail_date: mail.date ? mail.date.toISOString() : '',
            attachment: att.filename || '',
            bill_no: String(parsed.bill_no || '').trim(),
            bill_date: String(parsed.bill_date || '').slice(0, 10),
            party_name: String(parsed.party_name || '').trim(),
            total_amount: num(parsed.total_amount),
            row_sum: r2(rows.reduce((s, r) => s + r.gross_printed, 0)),
            rows,
            ai_model: model, ai_usage: { in: usage?.input_tokens || 0, out: usage?.output_tokens || 0 },
            status: 'PENDING_REVIEW',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          stats.parsed++;
          log(`  📄 ${att.filename}: bill ${parsed.bill_no || '?'} — ${rows.length} rows → PENDING_REVIEW`);
        }
      } catch (e) {
        fullyParsed = false;
        stats.errors.push(`uid ${uid}: ${e.message}`);
        log(`  ⚠️ mail uid ${uid}: ${e.message}`);
      }
      // Mark seen only when every attachment landed — failed mails retry next cycle
      if (fullyParsed) await client.messageFlagsAdd(String(uid), ['\\Seen']).catch(() => {});
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  log(`✅ ${label}: ${stats.mails} unseen mails, ${stats.pdfs} PDFs, ${stats.parsed} parsed, ${stats.skipped} already done${stats.errors.length ? `, ${stats.errors.length} errors` : ''}`);
  return stats;
}

// ── Cycle: master switch -> active accounts -> sequential loop ─────────────
let running = false;
async function runOnce() {
  if (running) { log('⏭️ previous cycle still running — skipping'); return; }
  running = true;
  try {
    const settings = (await db.collection('EMAIL_SETTINGS').doc('master').get()).data() || {};
    if (!settings.master_switch) { log('🔴 Master Switch OFF — nothing to do'); return; }
    if (!anthropic) { log('❌ ANTHROPIC_API_KEY missing in .env — extraction impossible, skipping cycle'); return; }

    const snap = await db.collection('EMAIL_ACCOUNTS').where('status', '==', 'Active').get();
    if (snap.empty) { log('🟡 Master Switch ON but no Active accounts in EMAIL_ACCOUNTS'); return; }
    log(`🟢 Master Switch ON — ${snap.size} active account(s)`);

    for (const doc of snap.docs) {
      const acc = { id: doc.id, ...doc.data() };
      try {
        const stats = await processAccount(acc);
        await doc.ref.update({
          last_checked_at: admin.firestore.FieldValue.serverTimestamp(),
          last_result: `OK: ${stats.parsed} parsed / ${stats.pdfs} PDFs`,
          last_error: stats.errors.slice(0, 3).join(' | ') || '',
        });
      } catch (e) {
        // One broken account (bad password / host down) never stops the others
        log(`❌ ${acc.email}: ${e.message}`);
        await doc.ref.update({
          last_checked_at: admin.firestore.FieldValue.serverTimestamp(),
          last_result: 'FAILED',
          last_error: String(e.message || e).slice(0, 300),
        }).catch(() => {});
      }
    }
  } catch (e) {
    log('❌ cycle error:', e.message);
  } finally {
    running = false;
  }
}

async function main() {
  log(`📧 Email Bill Parser started (${ONCE ? 'single pass' : 'scheduler'}) — model ${CLAUDE_MODEL}`);
  await runOnce();
  if (ONCE) { log('done.'); process.exit(0); }
  const tick = async () => {
    const settings = (await db.collection('EMAIL_SETTINGS').doc('master').get().catch(() => null))?.data() || {};
    const mins = Math.max(2, Number(settings.poll_minutes) || 10);
    setTimeout(async () => { await runOnce(); tick(); }, mins * 60000);
    log(`⏰ next check in ${mins} min`);
  };
  tick();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
