require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios'); 

const app = express();
app.use(cors());
// AI Bill Scanner sends multi-page base64 images in the chat body — default 100kb limit is far too small
app.use(express.json({ limit: '50mb' }));

const upload = multer({ dest: 'uploads/' });

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
app.post('/upload-to-drive', upload.single('file'), async (req, res) => {
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
app.get('/test-email', async (req, res) => {
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
app.post('/speak', async (req, res) => {
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
  });
});

app.post('/api/ai/chat', async (req, res) => {
  const { engine = 'local', messages = [], options = {} } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ success: false, error: 'messages[] required' });
  }

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
    const r = await axios.post(`${OLLAMA_URL}/api/chat`, ollamaBody, { timeout: 180000 });
    return res.json({ success: true, engine: 'local', model: r.data?.model, content: r.data?.message?.content || '' });
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

// --- 4. START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PRASAD ERP BRIDGE IS LIVE ON PORT ${PORT}`);
});