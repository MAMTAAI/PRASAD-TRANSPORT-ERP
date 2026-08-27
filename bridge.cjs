require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios'); 

const crypto = require('crypto');
const soc = require('./security.cjs'); // 🛡️ SOC Phase-0 SHADOW event store

const app = express();

// Real client IP — behind Nginx / the Cloudflare Tunnel the socket peer is
// always 127.0.0.1; the first X-Forwarded-For entry is the actual caller.
const realIp = (req) => (req.get('X-Forwarded-For') || '').split(',')[0].trim()
  || req.socket.remoteAddress || '';

// ── 🔐 CORS — allowlist, not wide-open. Once this bridge is exposed to the
// public internet via the Cloudflare Tunnel, only our own front-ends should be
// allowed to call it from a browser. Extra origins can be added via .env
// (ALLOWED_ORIGINS=comma,separated). Requests with NO Origin header (curl, the
// native Capacitor app, server-to-server) are allowed through — CORS only
// governs browser cross-site calls.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  || 'https://www.prasadtransport.com,https://prasadtransport.com,http://localhost:5173,http://localhost:4173,capacitor://localhost,http://localhost'
).split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    soc.capture({ kind: 'threat', severity: 'low', sensor: 'bridge-cors', category: 'cors-denied', message: `Origin not allowed: ${origin}`, action: 'blocked-cors' });
    return cb(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  allowedHeaders: ['Content-Type', 'X-PT-Token', 'X-KG-Domain'],
  exposedHeaders: ['X-KG-Facts', 'X-AI-Engine'],
  methods: ['GET', 'POST', 'OPTIONS'],
}));

// AI Bill Scanner sends multi-page base64 images in the chat body — default 100kb limit is far too small
app.use(express.json({ limit: '50mb' }));

// 🛡️ PHASE-1 ENFORCEMENT (no-op unless SOC_ARM=1). A banned IP is dropped at the
// app edge with 403 before any handler runs. In shadow mode isBanned() always
// returns false, so this is inert — bans are only logged, never applied.
app.use((req, res, next) => {
  try {
    if (soc.isBanned(realIp(req))) {
      return res.status(403).json({ success: false, error: 'IP banned by MAMTA active defense.' });
    }
  } catch { /* defense must never break the request path */ }
  next();
});

// 🔴 KILL-SWITCH ENFORCEMENT — when God engages the manual kill-switch, the
// sensitive surfaces (AI, payout-ingest, uploads) return 503. Read-only radar
// endpoints stay up so you can still see + release. Never auto-engaged.
// Cache kill state in memory; refresh on each mutation + a slow poll so a
// restart or the sibling infra's change is picked up.
let killState = soc.killState();
setInterval(() => { try { killState = soc.killState(); } catch { /* keep last */ } }, 15000);
const KILL_PROTECTED = [/^\/api\/ai\//, /^\/upload-to-drive/, /^\/speak/, /^\/api\/kg\//];
app.use((req, res, next) => {
  try {
    if (killState.active && KILL_PROTECTED.some((re) => re.test(req.path))) {
      return res.status(503).json({ success: false, error: 'System halted by MAMTA kill-switch (God).', by: killState.by, since: killState.ts });
    }
  } catch { /* fail open on the kill check itself — never hard-lock the box */ }
  next();
});

// ── 🔑 Shared-secret gate for the AI routes. The tunnel makes this bridge
// reachable from anywhere; PT_BRIDGE_TOKEN keeps random internet traffic out.
// Each client app sends its secret as the `X-PT-Token` header (front-ends read
// it from VITE_LLM_AUTH_TOKEN; server-to-server callers set the header directly).
//
// MULTIPLE tokens are supported — comma-separated — so every consumer gets its
// OWN secret and can be rotated/revoked independently:
//   PT_BRIDGE_TOKEN=<prasad-transport-token>,<jaiswal-capital-token>
// If the var is UNSET the gate is disabled — that keeps pure-local dev (no
// tunnel) frictionless. SET IT before opening the Cloudflare Tunnel.
// ONE BRIDGE, ONE TENANT (2026-08-16).
//
// This used to accept a comma-separated list of tokens and use the INDEX of the
// matching token as the tenant identity: 0 = Prasad Transport, 1 = Jaiswal
// Capital. That worked, and the isolation it enforced was real -- but it meant
// one process, one graph file and one queue served two companies, and the whole
// separation rested on the order of entries in an env var. Reordering
// PT_BRIDGE_TOKEN silently swapped which company's facts each side could read.
//
// Now the tenant is fixed at boot by BRIDGE_TENANT, one token is accepted, and
// the graph file is whatever KG_DB_PATH points at. Two companies means two
// processes on two ports with two databases. Isolation you cannot misconfigure
// by editing a list.
const TENANTS = { transport: 'transport', trading: 'trading' };
const BRIDGE_TENANT = TENANTS[(process.env.BRIDGE_TENANT || 'transport').toLowerCase().trim()];
if (!BRIDGE_TENANT) {
  console.error(`FATAL: BRIDGE_TENANT must be one of ${Object.keys(TENANTS).join(' | ')} -- got '${process.env.BRIDGE_TENANT}'`);
  process.exit(1);
}
const BRIDGE_TOKENS = (process.env.PT_BRIDGE_TOKEN || '')
  .split(',').map((t) => t.trim()).filter(Boolean);
if (BRIDGE_TOKENS.length > 1) {
  // Refuse rather than silently serve two tenants from one process again.
  console.error(`FATAL: PT_BRIDGE_TOKEN holds ${BRIDGE_TOKENS.length} tokens. This bridge serves ONE tenant ('${BRIDGE_TENANT}'). Run a second bridge, on its own port, with its own token and its own KG_DB_PATH.`);
  process.exit(1);
}
if (!BRIDGE_TOKENS.length) {
  console.warn('⚠️  PT_BRIDGE_TOKEN is not set -- AI routes are UNAUTHENTICATED. Fine for local-only use; set it before opening the Cloudflare Tunnel.');
} else {
  console.log(`🔒 AI routes protected -- tenant '${BRIDGE_TENANT}', 1 token accepted.`);
}
function matchedTokenIndex(supplied) {
  const s = Buffer.from(supplied, 'utf8');
  // Constant-time compare against EVERY accepted token; timingSafeEqual throws
  // on length mismatch, so guard length first. Loop runs fully (no early return)
  // to avoid leaking which token matched via timing. The index doubles as the
  // client identity: 0 = Prasad Transport, 1 = Jaiswal Capital (KG domain routing).
  let idx = -1;
  for (let i = 0; i < BRIDGE_TOKENS.length; i++) {
    const t = Buffer.from(BRIDGE_TOKENS[i], 'utf8');
    if (s.length === t.length && crypto.timingSafeEqual(s, t) && idx === -1) idx = i;
  }
  return idx;
}
function requireToken(req, res, next) {
  if (!BRIDGE_TOKENS.length) { req.ptClient = 0; return next(); } // gate disabled (local dev)
  const idx = matchedTokenIndex(req.get('X-PT-Token') || '');
  if (idx !== -1) { req.ptClient = idx; return next(); }
  // 🛡️ Spoof audit (Jaiswal P0 step 4): a wrong token is an explicit 401 AND a
  // SOC event — never a silent pass-through.
  soc.capture({
    kind: 'threat', severity: req.get('X-PT-Token') ? 'high' : 'med',
    sensor: 'bridge-auth', category: req.get('X-PT-Token') ? 'bad-token' : 'missing-token',
    ip: realIp(req), method: req.method, path: req.path, action: 'blocked-401',
  });
  return res.status(401).json({ success: false, error: 'Unauthorized: bad or missing X-PT-Token.' });
}

// Uploads land on the data volume, never the OS drive (God rule 2026-08-15:
// C: is off-limits for application data). UPLOAD_DIR comes from .env
// (F:/Prasad_Transport_Data/uploads on the office PC). The old relative
// 'uploads/' only stayed off C: by accident — it depended on the process cwd
// AND on the repo's uploads/ junction still existing.
const UPLOAD_DEST = process.env.UPLOAD_DIR
  ? path.join(process.env.UPLOAD_DIR, 'bridge')
  : path.join(__dirname, 'uploads', 'bridge');
fs.mkdirSync(UPLOAD_DEST, { recursive: true });
const upload = multer({ dest: UPLOAD_DEST });

// --- 1. GOOGLE DRIVE SETUP ---
const KEYFILEPATH = './google-key.json';
const SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.send'];
const auth = new google.auth.GoogleAuth({ keyFile: KEYFILEPATH, scopes: SCOPES });

// --- 2. MAMTA AI (GEMINI) SETUP ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || ''; // set in .env (never commit keys)

// =======================================================
// ROUTE 1: UPLOAD & EXTRACT DATA (DRIVE + SUPER AI)
// =======================================================
app.post('/upload-to-drive', requireToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded!" });

  try {
    const driveService = google.drive({ version: 'v3', auth });
    const driverName = req.body.driverName || "Unknown_Driver"; 
    const MAIN_FOLDER_ID = '1wxmHB_494sxqMKus7JKv8B83i67mEXer';

    // --- PART A: GOOGLE DRIVE SMART UPLOAD ---
    let driverFolderId = null;
    const folderSearch = await driveService.files.list({
      q: `name='${driverName}' and '${MAIN_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)', supportsAllDrives: true, includeItemsFromAllDrives: true
    });

    if (folderSearch.data.files && folderSearch.data.files.length > 0) {
      driverFolderId = folderSearch.data.files[0].id;
    } else {
      const folderResponse = await driveService.files.create({
        resource: { name: driverName, mimeType: 'application/vnd.google-apps.folder', parents: [MAIN_FOLDER_ID] },
        fields: 'id', supportsAllDrives: true
      });
      driverFolderId = folderResponse.data.id;
    }

    const date = new Date();
    const sysFileName = `${driverName}_${date.toLocaleDateString('en-GB').replace(/\//g, '-')}_${date.toLocaleTimeString('en-GB').replace(/:/g, '-')}_${req.file.originalname}`;

    const driveResponse = await driveService.files.create({
      resource: { name: sysFileName, parents: [driverFolderId] },
      media: { mimeType: req.file.mimetype, body: fs.createReadStream(req.file.path) },
      fields: 'id, webViewLink', supportsAllDrives: true
    });

    await driveService.permissions.create({
      fileId: driveResponse.data.id, requestBody: { role: 'reader', type: 'anyone' }, supportsAllDrives: true
    });

    const driveLink = driveResponse.data.webViewLink;

    // --- PART B: MAMTA AI DATA EXTRACTION (THE BRAIN UPGRADE) ---
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    function fileToGenerativePart(filePath, mimeType) {
        return { inlineData: { data: Buffer.from(fs.readFileSync(filePath)).toString("base64"), mimeType } };
    }
    const imageParts = [fileToGenerativePart(req.file.path, req.file.mimetype)];

    // 🚀 THE NEW UNIVERSAL TRANSPORT PROMPT
    const prompt = `
    You are Mamta AI, an expert Logistics & Transport AI for Prasad Transport ERP.
    Analyze the uploaded document (IOCL Invoice, Loading Slip, Challan, etc.) carefully.
    Return the output STRICTLY as a valid JSON object. No extra text, no markdown like \`\`\`json.

    CRITICAL INSTRUCTIONS:
    1. documentNumber: ALWAYS prioritize 'SAP Entry No.' or 'Delivery No.' (usually 10 digits starting with 70, e.g., 7004468793) over the Tax Invoice number. If SAP is missing, then use Invoice/Challan No.
    2. quantity: Find the TOTAL VOLUME / QTY of fuel. If it is in KL (e.g., 9, 3, 12.000), multiply by 1000 and return ONLY the number in LITERS (e.g., "12000"). NEVER return the Total Rupees/Amount here.
    3. vehicleNumber: Extract the truck registration number and REMOVE ALL SPACES (e.g., "AS 26 AC 0403" must become "AS26AC0403").
    4. consigneeName: Look for the destination party name (e.g., "COCO SHIV SHANKAR KSK").
    5. fromLocation: Look for the loading point or depot name (e.g., "BONGAIGAON REF").

    Use this exact JSON structure:
    {
      "documentType": "Invoice/Challan Type",
      "documentNumber": "70XXXXXXXX or Challan No",
      "documentDate": "YYYY-MM-DD",
      "vehicleNumber": "TRUCKNO",
      "partyName": "Supplier Name",
      "fromLocation": "Loading Point",
      "toLocation": "Consignee Name",
      "quantity": "Volume in Liters",
      "totalAmount": "Total Value in Rupees",
      "driverName": "Driver Name if any",
      "extraDetails": ""
    }
    `;

    const aiResult = await model.generateContent([prompt, ...imageParts]);
    let responseText = aiResult.response.text();
    
    // Safety clean
    responseText = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();
    
    let extractedData = {};
    try {
        extractedData = JSON.parse(responseText);
        console.log("🤖 MAMTA AI SUCCESSFUL EXTRACTION:", extractedData);
    } catch (parseError) {
        console.error("❌ JSON Parse Error. Raw AI Output:", responseText);
        extractedData = { error: "AI Format Error", rawText: responseText };
    }

    // --- PART C: SEND FINAL RESULT TO WEBSITE ---
    res.status(200).json({ success: true, driveLink: driveLink, aiData: extractedData });

  } catch (error) {
    console.error("❌ ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

// =======================================================
// ROUTE 2: AUTO EMAIL SENDING TEST
// =======================================================
app.get('/test-email', requireToken, async (req, res) => {
  try {
    const keys = require('./google-key.json');
    const jwtClient = new google.auth.JWT(
      keys.client_email, null, keys.private_key,
      ['https://www.googleapis.com/auth/gmail.send'],
      'info@prasadtransport.com' 
    );
    await jwtClient.authorize();

    const gmail = google.gmail({ version: 'v1', auth: jwtClient });
    const rawMessage = [
      `To: jaiswalcapital1@gmail.com`,
      'Subject: 🎉 Prasad Transport ERP - Live Test Successful!',
      '',
      'Hello Subhash Sir,\n\nCongratulations! This is an automatic test email sent directly from your ERP System using the new info@prasadtransport.com ID. Your robot is working perfectly!\n\nRegards,\nERP Robot 🤖'
    ].join('\n');

    const encodedMessage = Buffer.from(rawMessage).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedMessage } });
    res.status(200).send(`<h1 style="color: green; text-align:center;">✅ SUCCESS! Email Sent.</h1>`);
  } catch (error) {
    console.error("❌ EMAIL ERROR:", error);
    res.status(500).send(`<h1 style="color: red; text-align:center;">❌ ERROR: ${error.message}</h1>`);
  }
});

// =======================================================
// ROUTE 3: MAMTA AI PREMIUM VOICE 
// =======================================================
app.post('/speak', requireToken, async (req, res) => {
    try {
        const { text } = req.body;
        const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`;
        const requestBody = {
            input: { text: text },
            voice: { languageCode: 'hi-IN', name: 'hi-IN-Neural2-A', ssmlGender: 'FEMALE' },
            audioConfig: { audioEncoding: 'MP3', pitch: 1.2, speakingRate: 0.95 }
        };
        const response = await axios.post(url, requestBody);
        res.json({ success: true, audioContent: response.data.audioContent });
    } catch (error) {
        console.error("TTS API Error:", error.message);
        res.status(500).json({ success: false, message: "Voice generation failed." });
    }
});

// =======================================================
// ROUTE 4: 🤖 DUAL-AI ENGINE — Claude (cloud) / Ollama (local) chat controller
// Frontend sends {engine, messages, options}; `engine` decides the route:
//   'cloud' -> Anthropic API (Claude Haiku), key from process.env.ANTHROPIC_API_KEY
//   'local' -> proxied to the Ollama server (same structure the frontend uses
//              directly; yahan bhi support hai taaki remote/mobile clients jo
//              localhost:11434 tak nahi pahunch sakte, bridge ke through local
//              engine bhi chala sakein)
// Messages use the app's provider-neutral ChatMessage shape:
//   { role, content, images?: [base64-no-prefix] }
// =======================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const OLLAMA_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');

// ── 🎮 UPSTREAM AI ENGINE ROUTING ─────────────────────────────────────
// Primary can be a REMOTE engine (RTX 3060 PC via the Cloudflare Tunnel —
// that endpoint is itself a token-gated bridge, so OLLAMA_AUTH_TOKEN is
// sent as X-PT-Token). OLLAMA_MODEL_OVERRIDE pins every upstream call to
// one model (e.g. gemma4:12b) no matter what the client asked for.
// If the primary fails for ANY reason (PC off, tunnel down, model
// missing), one retry goes to OLLAMA_FALLBACK_URL with the fallback
// model — AI degrades to the on-box engine instead of dying.
const OLLAMA_AUTH_TOKEN = process.env.OLLAMA_AUTH_TOKEN || '';
const OLLAMA_MODEL_OVERRIDE = process.env.OLLAMA_MODEL_OVERRIDE || '';
const OLLAMA_FALLBACK_URL = (process.env.OLLAMA_FALLBACK_URL || '').replace(/\/+$/, '');
const OLLAMA_FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL || '';
const ollamaHeaders = () => (OLLAMA_AUTH_TOKEN ? { 'X-PT-Token': OLLAMA_AUTH_TOKEN } : {});
const engineLabel = (url) => (/localhost|127\.0\.0\.1/.test(url) ? 'aws-local' : 'rtx3060');

// ── ⚖️ HYBRID TASK ROUTING (God 2026-08-22) ───────────────────
// Light/routine work stays on the on-box gemma (fast, always available).
// Heavy reasoning escalates to the Local Power PC (RTX 3060, DeepSeek-R1)
// through the token-gated Cloudflare tunnel. If the PC is off, heavy work
// degrades to the on-box engine instead of dying.
const OLLAMA_HEAVY_URL = (process.env.OLLAMA_HEAVY_URL || '').replace(/\/+$/, '');
const OLLAMA_HEAVY_MODEL = process.env.OLLAMA_HEAVY_MODEL || '';
const OLLAMA_HEAVY_TOKEN = process.env.OLLAMA_HEAVY_TOKEN || '';
const OLLAMA_LIGHT_MODEL = process.env.OLLAMA_LIGHT_MODEL || '';
const HEAVY_CHAR_THRESHOLD = Number(process.env.OLLAMA_HEAVY_CHAR_THRESHOLD || 1500);
const HEAVY_RX = /analy[sz]|reconcil|audit|forecast|balance\s*sheet|profit\s*(and|&)?\s*loss|p&l|ledger\s*review|financial|hisaab|vishleshan|deep\s*(think|reason)|strategy|likho.*code|write.*code|समीक्षा|विश्लेषण/i;
function isHeavyTask(body) {
  if (body && body.options && body.options.heavy === true) return true;
  const msgs = (body && body.messages) || [];
  const text = msgs.map(m => String((m && m.content) || '')).join(' ');
  if (text.length > HEAVY_CHAR_THRESHOLD) return true;
  return HEAVY_RX.test(text);
}

async function ollamaPost(pathname, body, axiosOpts = {}) {
  // HEAVY path: Local Power PC (DeepSeek-R1) via tunnel, on-box fallback.
  if (OLLAMA_HEAVY_URL && isHeavyTask(body)) {
    const heavyBody = OLLAMA_HEAVY_MODEL ? { ...body, model: OLLAMA_HEAVY_MODEL } : body;
    try {
      const resp = await axios.post(`${OLLAMA_HEAVY_URL}${pathname}`, heavyBody, { ...axiosOpts, headers: { ...(axiosOpts.headers || {}), ...(OLLAMA_HEAVY_TOKEN ? { 'X-PT-Token': OLLAMA_HEAVY_TOKEN } : {}) } });
      return { resp, engine: OLLAMA_HEAVY_URL };
    } catch (err) {
      console.warn(`⚠️  Heavy engine (RTX3060) unreachable (${err.message}) — degrading to on-box gemma`);
    }
  }
  // LIGHT path (or heavy degraded): on-box gemma.
  const lightModel = OLLAMA_MODEL_OVERRIDE || OLLAMA_LIGHT_MODEL;
  const primaryBody = lightModel ? { ...body, model: lightModel } : body;
  try {
    const resp = await axios.post(`${OLLAMA_URL}${pathname}`, primaryBody, { ...axiosOpts, headers: { ...(axiosOpts.headers || {}), ...ollamaHeaders() } });
    return { resp, engine: OLLAMA_URL };
  } catch (err) {
    if (!OLLAMA_FALLBACK_URL) throw err;
    console.warn(`⚠️  Primary AI engine failed (${err.message}) — falling back to ${OLLAMA_FALLBACK_URL}`);
    const fbBody = OLLAMA_FALLBACK_MODEL ? { ...body, model: OLLAMA_FALLBACK_MODEL } : body;
    const resp = await axios.post(`${OLLAMA_FALLBACK_URL}${pathname}`, fbBody, axiosOpts);
    return { resp, engine: OLLAMA_FALLBACK_URL };
  }
}

// Anthropic structured outputs demand strict schemas: every object node needs
// additionalProperties:false. Ollama's grammar mode doesn't — so we upgrade the
// frontend's existing schemas here instead of duplicating them per engine.
function toStrictSchema(node) {
  if (!node || typeof node !== 'object') return node;
  const out = Array.isArray(node) ? node.map(toStrictSchema) : { ...node };
  if (!Array.isArray(node)) {
    if (out.type === 'object') {
      out.additionalProperties = false;
      if (!out.required && out.properties) out.required = Object.keys(out.properties);
    }
    for (const k of ['properties', 'items']) if (out[k]) out[k] = toStrictSchema(out[k]);
    if (out.properties) for (const p of Object.keys(out.properties)) out.properties[p] = toStrictSchema(out.properties[p]);
  }
  return out;
}

// ChatMessage[] (Ollama-style: content + images[]) -> Anthropic SDK content blocks
function toClaudeMessages(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const turns = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [
      // images pehle, phir text — vision best practice (document before question)
      ...(m.images || []).map(b64 => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
      })),
      { type: 'text', text: m.content || ' ' },
    ],
  }));
  return { system, turns };
}

// Health: UI isse batati hai ki cloud engine ready hai ya nahi (bina key bheje)
app.get('/api/ai/health', (req, res) => {
  res.json({
    ok: true,
    cloud_configured: !!anthropic,
    cloud_model: CLAUDE_MODEL,
    ollama_url: OLLAMA_URL,
    model_override: OLLAMA_MODEL_OVERRIDE || null,
    fallback_url: OLLAMA_FALLBACK_URL || null,
    fallback_model: OLLAMA_FALLBACK_MODEL || null,
  });
});

app.post('/api/ai/chat', requireToken, async (req, res) => {
  const { engine = 'local', messages = [], options = {} } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ success: false, error: 'messages[] required' });
  }

  // 🕸️ GraphRAG: MAMTA KG ke verified facts → system context (dono engines ko milta hai)
  const kgHit = kgInject({ messages }, kgDomainForReq(req));
  if (kgHit) res.setHeader('X-KG-Facts', String(kgHit.facts));

  try {
    if (engine === 'cloud') {
      // ── CLOUD: Anthropic API (Claude Haiku) ──────────────────────────────
      if (!anthropic) {
        return res.status(503).json({ success: false, error: 'ANTHROPIC_API_KEY .env me set nahi hai — bridge restart karke dobara try karein.' });
      }
      const { system, turns } = toClaudeMessages(messages);
      const params = {
        model: options.model || CLAUDE_MODEL,
        max_tokens: 8192,
        messages: turns,
      };
      if (system) params.system = system;
      if (typeof options.temperature === 'number') params.temperature = options.temperature;
      // Ollama `format: <schema>` ka Claude equivalent: structured outputs
      if (options.format && typeof options.format === 'object') {
        params.output_config = { format: { type: 'json_schema', schema: toStrictSchema(options.format) } };
      }
      const msg = await anthropic.messages.create(params);
      if (msg.stop_reason === 'refusal') {
        return res.status(422).json({ success: false, error: 'Cloud AI ne is request ko decline kar diya (safety). Local AI engine try karein.' });
      }
      const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      return res.json({ success: true, engine: 'cloud', model: msg.model, content: text, stop_reason: msg.stop_reason, usage: msg.usage });
    }

    // ── LOCAL: proxy to Ollama (structure unchanged — same body Ollama expects) ──
    const ollamaBody = {
      model: options.model || process.env.OLLAMA_MODEL || 'gemma4:12b',
      messages: messages.map(m => ({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images } : {}) })),
      stream: false,
      options: {
        ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
        ...(options.numCtx ? { num_ctx: options.numCtx } : {}),
      },
      ...(options.format ? { format: options.format } : {}),
      ...(options.think === false ? { think: false } : {}),
    };
    const { resp: r, engine: usedEngine } = await ollamaPost('/api/chat', ollamaBody, { timeout: 300000 });
    return res.json({ success: true, engine: 'local', ai_engine: engineLabel(usedEngine), model: r.data?.model, content: r.data?.message?.content || '' });
  } catch (error) {
    // Typed Anthropic errors -> clean status + message for the frontend
    if (Anthropic && error instanceof Anthropic.APIError) {
      console.error(`❌ Claude API ${error.status}:`, error.message);
      return res.status(error.status || 500).json({ success: false, error: `Cloud AI error (${error.status}): ${error.message}` });
    }
    const offline = error.code === 'ECONNREFUSED' || /ECONNREFUSED|ENOTFOUND/.test(error.message || '');
    console.error('❌ AI chat error:', error.message);
    return res.status(offline ? 503 : 500).json({ success: false, error: offline ? 'Local AI engine (Ollama) is not reachable from the bridge.' : (error.message || 'AI request failed') });
  }
});

// =======================================================
// ROUTE 5: 🦙 OLLAMA-NATIVE PASSTHROUGH (secure tunnel path)
// The deployed HTTPS site can't reach http://localhost:11434 (Mixed Content +
// it's the *visitor's* localhost, not this PC). So the browser's OllamaProvider
// points VITE_LLM_BASE_URL at the Cloudflare Tunnel → this bridge, which relays
// the SAME native Ollama requests to the real engine. Behaviour is identical to
// talking to Ollama directly — including token-by-token streaming — so no
// front-end logic changes, only the base URL + the X-PT-Token header.
//
// We expose ONLY the two endpoints the app uses (list models + chat), NOT the
// full Ollama admin API (pull/delete/create), so an exposed URL can't be abused
// to mutate models or hijack the GPU beyond a chat call.
// =======================================================
function ollamaUnreachable(err, res) {
  const offline = err.code === 'ECONNREFUSED' || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(err.message || '');
  console.error('❌ Ollama passthrough error:', err.message);
  return res.status(offline ? 503 : 500).json({
    error: offline ? 'Local AI engine (Ollama) is not reachable from the bridge.' : (err.message || 'Ollama proxy error'),
  });
}

// GET /api/tags — model list + reachability (OllamaProvider.health uses this)
app.get('/api/tags', requireToken, async (req, res) => {
  try {
    const r = await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 15000, headers: ollamaHeaders() });
    return res.json(r.data);
  } catch (err) {
    if (!OLLAMA_FALLBACK_URL) return ollamaUnreachable(err, res);
    try {
      const r = await axios.get(`${OLLAMA_FALLBACK_URL}/api/tags`, { timeout: 15000 });
      return res.json(r.data);
    } catch (e2) { return ollamaUnreachable(e2, res); }
  }
});

// POST /api/chat — chat, streaming or one-shot. When the caller asks for a
// stream (body.stream !== false), we pipe Ollama's NDJSON straight through so
// the UI still renders tokens as they arrive.
app.post('/api/chat', requireToken, async (req, res) => {
  const body = req.body || {};
  const wantStream = body.stream !== false; // Ollama defaults to streaming
  // 🕸️ GraphRAG: verified org facts → system context before Gemma sees the question
  const kgHit = kgInject(body, kgDomainForReq(req));
  if (kgHit) res.setHeader('X-KG-Facts', String(kgHit.facts));
  try {
    const { resp: upstream, engine } = await ollamaPost('/api/chat', body, {
      responseType: wantStream ? 'stream' : 'json',
      timeout: 600000,
    });
    res.setHeader('X-AI-Engine', engineLabel(engine));
    if (!wantStream) return res.json(upstream.data);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    upstream.data.pipe(res);
    upstream.data.on('error', (e) => { console.error('stream relay error:', e.message); try { res.end(); } catch { /* already closed */ } });
    req.on('close', () => { try { upstream.data.destroy(); } catch { /* noop */ } }); // client bailed → stop pulling from Ollama
  } catch (err) {
    return ollamaUnreachable(err, res);
  }
});

// =======================================================
// ROUTE 6: 🕸️ MAMTA KG — GraphRAG / knowledge graph (kg/graph.cjs)
// SQLite-backed (better-sqlite3, WAL) — NO graph-DB server, RAM-safe
// next to the trading engine. Domain isolation: transport | trading |
// shared, fixed by the client's token (0=Prasad, 1=Jaiswal); the
// X-KG-Domain header / kg_domain body field can only pick 'shared'.
// =======================================================
const kg = require('./kg/graph.cjs');
// Seed only this tenant's graph. Seeding 'trading' from the Prasad repo is how
// Jaiswal facts ended up in a file on the Prasad drive in the first place.
try {
  kg.ensureSeed(`${__dirname}/kg/seed-${BRIDGE_TENANT}.json`, BRIDGE_TENANT);
} catch (e) { console.warn(`KG seed skipped for '${BRIDGE_TENANT}':`, e.message); }
console.log(`🕸️  KG file: ${process.env.KG_DB_PATH || '(default: data/mamta-kg.db)'}`);

function kgDomainForReq(req) {
  const d = req.get('X-KG-Domain') || (req.body && req.body.kg_domain);
  if (req.body && req.body.kg_domain !== undefined) delete req.body.kg_domain; // Ollama ko forward nahi karna
  // STRICT TENANT ISOLATION (2026-07-28): domain is fixed by the authenticated
  // token — a cross-tenant X-KG-Domain is DENIED (transport token can never read
  // 'trading' financial facts, and vice-versa). 'shared' remains common ground.
  // The tenant is this PROCESS, not the caller and not a token position. A
  // cross-tenant X-KG-Domain is ignored, exactly as before -- but now the other
  // tenant's facts are not merely forbidden, they are in a different file on a
  // different drive, and this process never opens it.
  const allowed = BRIDGE_TENANT;
  if (d === allowed) return d;
  return allowed;
}

// Mutates body.messages: appends verified graph facts to the system prompt.
// Any failure = silent skip — chat kabhi block nahi hota KG ki wajah se.
function kgInject(body, domain) {
  try {
    const msgs = body && body.messages;
    if (!Array.isArray(msgs) || !msgs.length) return null;
    const lastUser = [...msgs].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string');
    if (!lastUser) return null;
    const hit = kg.contextForMessage(lastUser.content, { domain });
    if (!hit) return null;
    const sys = msgs.find((m) => m && m.role === 'system');
    if (sys) sys.content = `${sys.content}\n\n${hit.context}`;
    else msgs.unshift({ role: 'system', content: hit.context });
    console.log(`🕸️ KG: +${hit.facts} facts injected (${domain}, ${hit.entities} entities)`);
    return hit;
  } catch (e) {
    console.warn('KG inject skipped:', e.message);
    return null;
  }
}

app.get('/api/kg/stats', requireToken, (req, res) => {
  try { res.json({ success: true, ...kg.stats() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/kg/query?entity=PB10AB1234&depth=2 — subgraph around an entity
app.get('/api/kg/query', requireToken, (req, res) => {
  try {
    const depth = Math.min(Number(req.query.depth) || 2, 3);
    res.json({ success: true, domain: kgDomainForReq(req), ...kg.queryEntity(String(req.query.entity || ''), { domain: kgDomainForReq(req), depth }) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/kg/upsert {nodes:[{type,name,domain,props,aliases}], edges:[{src:{type,name},rel,dst:{type,name},domain,weight,props}]}
app.post('/api/kg/upsert', requireToken, (req, res) => {
  try {
    const { nodes = [], edges = [] } = req.body || {};
    if (!nodes.length && !edges.length) return res.status(400).json({ success: false, error: 'nodes[] or edges[] required' });
    if (nodes.length + edges.length > 2000) return res.status(413).json({ success: false, error: 'max 2000 items per batch' });
    res.json({ success: true, ...kg.batchUpsert({ nodes, edges }) });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// POST /api/kg/learn {text, domain?} — Gemma extracts triples from free text.
// ON-DEMAND ONLY (CPU is shared with the trading engine — no background loops).
app.post('/api/kg/learn', requireToken, async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ success: false, error: 'text required' });
  const domain = kgDomainForReq(req);
  const schema = {
    type: 'object',
    required: ['triples'],
    properties: { triples: { type: 'array', items: {
      type: 'object',
      required: ['src_type', 'src_name', 'rel', 'dst_type', 'dst_name'],
      properties: { src_type: { type: 'string' }, src_name: { type: 'string' }, rel: { type: 'string' }, dst_type: { type: 'string' }, dst_name: { type: 'string' } },
    } } },
  };
  try {
    const { resp: r } = await ollamaPost('/api/chat', {
      model: (req.body && req.body.model) || process.env.OLLAMA_MODEL || 'gemma3:4b',
      stream: false,
      format: schema,
      messages: [
        { role: 'system', content: 'Extract factual knowledge-graph triples from the text. Types are short snake_case nouns (truck, driver, client, location, company, stock, sector, macro_event...). Relations are short snake_case verbs (driven_by, delivers_to, works_for, impacts_positive, impacts_negative...). Extract ONLY facts stated in the text — never invent.' },
        { role: 'user', content: text.slice(0, 4000) },
      ],
    }, { timeout: 300000 });
    const parsed = JSON.parse(r.data?.message?.content || '{}');
    const edges = (parsed.triples || [])
      .filter((t) => t.src_name && t.dst_name && t.rel)
      .map((t) => ({ src: { type: t.src_type || 'entity', name: t.src_name }, rel: t.rel, dst: { type: t.dst_type || 'entity', name: t.dst_name }, domain }));
    const counts = edges.length ? kg.batchUpsert({ edges }) : { nodes: 0, edges: 0 };
    return res.json({ success: true, domain, learned: counts.edges, triples: parsed.triples || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =======================================================
// ROUTE 7: 🛡️ MAMTA SOC — Phase-0 SHADOW radar (observe-only)
// Feeds the SecurityRadar dashboard widget. Same endpoint contract as the
// Jaiswal Capital SOC (§18b): GET /security/radar + POST /security/ack,
// plus /security/ingest for the local sensor servers (WhatsApp :5001,
// payout :5000) to forward their own auth-failure events.
// =======================================================
app.get('/security/radar', requireToken, (req, res) => {
  try { res.json(soc.radar(Number(req.query.limit) || 100)); }
  catch (e) { res.status(500).json({ status: 'error', error: e.message }); }
});

app.post('/security/ack', requireToken, (req, res) => {
  try { res.json({ success: soc.ack(req.body && req.body.id) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 🔴 Manual kill-switch — God-triggered ONLY. Requires the bridge token AND an
// explicit confirm string, so a stray/replayed request can't halt the business.
// This never fires automatically; it is the human "fight back" control.
app.post('/security/killswitch', requireToken, (req, res) => {
  try {
    const { active, confirm, by } = req.body || {};
    if (active && confirm !== 'HALT') {
      return res.status(400).json({ success: false, error: 'Refused: to engage, send confirm:"HALT".' });
    }
    killState = soc.setKill(!!active, by);
    console.log(`🔴 KILL-SWITCH ${active ? 'ENGAGED' : 'RELEASED'} by ${killState.by}`);
    res.json({ success: true, kill: killState });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/security/ingest', requireToken, (req, res) => {
  try {
    const e = req.body || {};
    if (!e.sensor || !e.category) return res.status(400).json({ success: false, error: 'sensor and category required' });
    soc.capture({ ...e, source: 'prasad' }); // ingest is Prasad-side sensors only
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// --- 4. START SERVER ---
// 🔒 P0 LOCKDOWN: loopback by default. Nginx (AWS) and cloudflared (this PC)
// both connect via 127.0.0.1, so nothing legitimate breaks — but the bridge is
// no longer reachable raw on the LAN/public IP. Set HOST=0.0.0.0 only if you
// deliberately need direct network exposure.
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`🚀 PRASAD ERP BRIDGE IS LIVE ON ${HOST}:${PORT}`);
});