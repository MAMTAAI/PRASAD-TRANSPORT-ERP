// @ts-nocheck
// 🟢 PRASAD PRO WhatsApp Engine — hardened for 24/7 local operation.
// Runs on THIS PC (persistent .wwebjs_auth on real disk) — cloud free-tiers
// wipe the session dir on every restart, which is why the old Render deploy
// kept falling back to "WAITING_FOR_SCAN".
//
//  • Auto-reconnect with exponential backoff + a getState() watchdog heartbeat
//  • Frontend-compatible API: GET /api/status/:userId, POST /api/send-whatsapp
//  • USER FOOTPRINT: every outbound message logs WHO sent it (sentByUserId /
//    sentByUserName / timestamp) to Firestore WA_CHATS + WA_LOGS via
//    firebase-admin; incoming replies are logged too so Trip Chat shows both sides.
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const stream = require('stream');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 🔥 FIRESTORE (audit trail + chat history)
// ==========================================
let fdb = null;
try {
    admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
    fdb = admin.firestore();
    console.log('🔥 Firestore connected (audit trail active).');
} catch (e) { console.error('⚠️ Firestore init failed — footprint logging disabled:', e.message); }

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

async function logChat(entry) {
    if (!fdb) return;
    try { await fdb.collection('WA_CHATS').add(entry); } catch (e) { console.error('WA_CHATS log error:', e.message); }
}
async function logAction(user, action) {
    if (!fdb) return;
    try { await fdb.collection('WA_LOGS').add({ user: user || 'System', action, timestamp: new Date().toISOString() }); } catch (e) { /* non-fatal */ }
}

// ==========================================
// 🗄️ LEGACY MONGO (old CRM panel routes) — optional, non-fatal
// ==========================================
const mongoURI = process.env.MONGO_URI || "mongodb://Mamta123:Bihar%405217@ac-ww17p1s-shard-00-00.wiygiox.mongodb.net:27017,ac-ww17p1s-shard-00-01.wiygiox.mongodb.net:27017,ac-ww17p1s-shard-00-02.wiygiox.mongodb.net:27017/?ssl=true&replicaSet=atlas-xtbebi-shard-0&authSource=admin&appName=Cluster0";
mongoose.connect(mongoURI)
    .then(() => console.log('🗄️ Mongo (legacy) connected.'))
    .catch(err => console.log('⚠️ Mongo (legacy) unavailable — legacy CRUD routes disabled:', err.message));

const Rule = mongoose.model('Rule', new mongoose.Schema({ keyword: String, reply: String }));
const Contact = mongoose.model('Contact', new mongoose.Schema({
    name: String, phone: String, category: String, company: String, truckNo: String, gst: String, details: String
}));
const Draft = mongoose.model('Draft', new mongoose.Schema({ title: String, content: String }));
const Task = mongoose.model('Task', new mongoose.Schema({ title: String, description: String, status: { type: String, default: 'LEAD' }, phone: String }));
const Signature = mongoose.model('Signature', new mongoose.Schema({ title: String, content: String }));

// ==========================================
// 📲 WHATSAPP ENGINE — hardened lifecycle
// ==========================================
let currentQR = '';
let isConnected = false;
let engineStatus = 'STARTING';        // STARTING | WAITING_FOR_SCAN | ONLINE | RECONNECTING | OFFLINE
let lastHeartbeat = null;
let reconnectAttempts = 0;
let reinitInFlight = false;

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions', '--disable-gpu'] }
});

function scheduleReinit(reason) {
    if (reinitInFlight) return;
    reinitInFlight = true;
    reconnectAttempts++;
    const delay = Math.min(60000, 3000 * Math.pow(2, Math.min(reconnectAttempts - 1, 5))); // 3s → 60s cap
    engineStatus = 'RECONNECTING';
    console.log(`🔁 Reconnect #${reconnectAttempts} in ${delay / 1000}s (${reason})`);
    setTimeout(async () => {
        try { await client.destroy().catch(() => {}); } catch (e) {}
        try { client.initialize(); } catch (e) { console.error('Re-init error:', e.message); }
        reinitInFlight = false;
    }, delay);
}

client.on('qr', (qr) => {
    currentQR = qr;
    isConnected = false;
    engineStatus = 'WAITING_FOR_SCAN';
    console.log('📲 New QR generated — scan from PRASAD PRO → Link WhatsApp.');
});

client.on('authenticated', () => { console.log('🔐 Session authenticated (restored from .wwebjs_auth or fresh scan).'); });

client.on('ready', () => {
    isConnected = true;
    currentQR = '';
    engineStatus = 'ONLINE';
    reconnectAttempts = 0;
    lastHeartbeat = new Date().toISOString();
    console.log('✅ WhatsApp ONLINE & Ready! PRASAD PRO active.');
    logAction('System', 'WhatsApp engine came ONLINE');
});

client.on('auth_failure', (msg) => {
    isConnected = false;
    console.error('❌ AUTH FAILURE:', msg);
    logAction('System', `WhatsApp auth failure: ${msg}`);
    scheduleReinit('auth_failure');
});

client.on('disconnected', (reason) => {
    isConnected = false;
    currentQR = '';
    console.log('❌ WhatsApp Disconnected! Reason:', reason);
    logAction('System', `WhatsApp disconnected: ${reason}`);
    scheduleReinit('disconnected');
});

// 🫀 WATCHDOG HEARTBEAT — every 45s verify the socket is truly alive;
// a hung puppeteer page reports nothing, so we probe getState() ourselves.
setInterval(async () => {
    try {
        const state = await client.getState();
        lastHeartbeat = new Date().toISOString();
        if (state === 'CONNECTED') {
            if (!isConnected) { isConnected = true; engineStatus = 'ONLINE'; }
        } else if (engineStatus !== 'WAITING_FOR_SCAN' && engineStatus !== 'RECONNECTING') {
            console.log('🫀 Heartbeat: state =', state, '→ scheduling recovery');
            isConnected = false;
            scheduleReinit(`heartbeat state ${state}`);
        }
    } catch (e) {
        if (engineStatus === 'ONLINE') {
            console.log('🫀 Heartbeat failed:', e.message, '→ scheduling recovery');
            isConnected = false;
            scheduleReinit('heartbeat error');
        }
    }
}, 45000);

// 🤖 Incoming messages: keyword auto-reply (legacy rules) + log to Trip Chat history.
client.on('message', async (msg) => {
    try {
        const from10 = last10(msg.from);
        await logChat({ phone: from10, text: msg.body, type: 'incoming', timestamp: new Date().toISOString(), wa_from: msg.from });
        const text = msg.body.toLowerCase().trim();
        const rule = await Rule.findOne({ keyword: text }).catch(() => null);
        if (rule) {
            await msg.reply(rule.reply);
            await logChat({ phone: from10, text: rule.reply, type: 'outgoing', userId: 'Mamta AI', sentByUserId: 'mamta-ai-bot', sentByUserName: 'Mamta AI', timestamp: new Date().toISOString() });
        } else if (text === 'hi' || text === 'hello') {
            const reply = 'नमस्कार! प्रसाद ट्रांसपोर्ट ERP में आपका स्वागत है। मैं Mamta AI हूँ। आपकी क्या सहायता करूँ? 🙏';
            await msg.reply(reply);
            await logChat({ phone: from10, text: reply, type: 'outgoing', userId: 'Mamta AI', sentByUserId: 'mamta-ai-bot', sentByUserName: 'Mamta AI', timestamp: new Date().toISOString() });
        }
    } catch (err) { console.error('Auto-reply Error:', err); }
});

client.initialize();

// ==========================================
// 🌐 API ROUTES
// ==========================================
const statusPayload = () => ({
    connected: isConnected,
    qr: currentQR,
    status: engineStatus,
    lastHeartbeat,
    reconnectAttempts,
    server: 'local-pc',
});
app.get('/api/status', (req, res) => res.json(statusPayload()));
app.get('/api/status/:userId', (req, res) => res.json(statusPayload())); // frontend contract

// 💬 SEND — frontend contract, with MANDATORY user footprint.
async function doSend({ number, message, userId, sentByUserId, sentByUserName, tripId, role }) {
    if (!isConnected) throw new Error('WhatsApp engine OFFLINE — Link WhatsApp tab se QR scan karein.');
    let formatted = String(number || '').replace(/\D/g, '');
    if (formatted.length === 10) formatted = `91${formatted}`;
    if (formatted.length < 11) throw new Error('Invalid phone number');
    const chatId = `${formatted}@c.us`;
    const sent = await client.sendMessage(chatId, message);
    const senderName = sentByUserName || userId || 'Unknown';
    await logChat({
        phone: last10(formatted), text: message, type: 'outgoing',
        userId: senderName,                       // legacy badge field
        sentByUserId: sentByUserId || senderName, // 👣 USER FOOTPRINT
        sentByUserName: senderName,
        tripId: tripId || null, role: role || null,
        timestamp: new Date().toISOString(),
        wa_msg_id: sent?.id?._serialized || null,
    });
    await logAction(senderName, `Sent WhatsApp to ${last10(formatted)}${tripId ? ` (Trip ${tripId})` : ''}`);
    return true;
}

app.post('/api/send-whatsapp', async (req, res) => {
    try { await doSend(req.body); res.json({ success: true }); }
    catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Legacy endpoint kept for old callers.
app.post('/api/send-message', async (req, res) => {
    try { await doSend({ number: req.body.phone, message: req.body.message, userId: req.body.userId || 'Legacy API' }); res.json({ success: true }); }
    catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/logout', async (req, res) => {
    try {
        await client.logout();
        isConnected = false;
        currentQR = '';
        engineStatus = 'WAITING_FOR_SCAN';
        logAction(req.body?.userId || 'Admin', 'Logged out WhatsApp session');
        res.json({ success: true, message: 'Logged out successfully' });
        scheduleReinit('manual logout');
    } catch (e) {
        res.status(500).json({ success: false, message: 'Failed to logout' });
    }
});

const setupRoutes = (path2, Model) => {
    app.get(`/api/${path2}`, async (req, res) => {
        try { res.json({ success: true, data: await Model.find().sort({ _id: -1 }) }); }
        catch (e) { res.status(500).json({ success: false }); }
    });
    app.post(`/api/${path2}`, async (req, res) => {
        try { const item = new Model(req.body); await item.save(); res.json({ success: true, item }); }
        catch (e) { res.status(500).json({ success: false }); }
    });
    app.delete(`/api/${path2}/:id`, async (req, res) => {
        try { await Model.findByIdAndDelete(req.params.id); res.json({ success: true }); }
        catch (e) { res.status(500).json({ success: false }); }
    });
};
setupRoutes('contacts', Contact);
setupRoutes('rules', Rule);
setupRoutes('drafts', Draft);
setupRoutes('tasks', Task);
setupRoutes('signatures', Signature);

app.post('/api/update-task', async (req, res) => {
    try { await Task.findByIdAndUpdate(req.body.id, { status: req.body.status }); res.json({ success: true }); }
    catch (e) { res.status(500).json({ success: false }); }
});

// ==============================================================
// 🚀 MAMTA AI DOCUMENT SCANNER + 📂 GOOGLE DRIVE AUTO-FOLDER SYNC (legacy)
// ==============================================================
const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const KEYFILEPATH = './google-key.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ keyFile: KEYFILEPATH, scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });
const MAIN_UPLOADS_FOLDER_ID = '1wxmHB_494sxqMKus7JKv8B83i67mEXer';

async function makeFilePublic(fileId) {
    try {
        await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone', allowFileDiscovery: false } });
        console.log(`🔓 Public access set for ${fileId}`);
    } catch (err) { console.error(`⚠️ Could not set public permissions for ${fileId}:`, err.message); }
}

app.post('/upload-to-drive', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file provided!' });
        const vehicleNo = req.body.driverName ? req.body.driverName.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : 'UNKNOWN_VEHICLE';
        const docType = req.body.docType ? req.body.docType.replace(/[^A-Za-z0-9]/g, '_') : 'Document';
        let vehicleFolderId = null;
        const folderSearch = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${vehicleNo}' and '${MAIN_UPLOADS_FOLDER_ID}' in parents and trashed=false`,
            fields: 'files(id, name)',
        });
        if (folderSearch.data.files.length > 0) vehicleFolderId = folderSearch.data.files[0].id;
        else {
            const folder = await drive.files.create({ resource: { name: vehicleNo, mimeType: 'application/vnd.google-apps.folder', parents: [MAIN_UPLOADS_FOLDER_ID] }, fields: 'id' });
            vehicleFolderId = folder.data.id;
            await makeFilePublic(vehicleFolderId);
        }
        const ext = req.file.originalname.split('.').pop() || 'pdf';
        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);
        const uploadedFile = await drive.files.create({
            resource: { name: `${docType}_${vehicleNo}_${Date.now()}.${ext}`, parents: [vehicleFolderId] },
            media: { mimeType: req.file.mimetype, body: bufferStream },
            fields: 'id, webViewLink, webContentLink'
        });
        await makeFilePublic(uploadedFile.data.id);
        let aiData = null;
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const prompt = `You are Mamta AI, an expert transport document analyzer. Read this vehicle document and extract in strictly valid JSON (no markdown): {"documentNumber":"...","documentDate":"...","expiryDate":"...","totalAmount":"..."}`;
            const result = await model.generateContent([prompt, { inlineData: { data: req.file.buffer.toString('base64'), mimeType: req.file.mimetype } }]);
            aiData = JSON.parse((await result.response).text().replace(/```json/gi, '').replace(/```/g, '').trim());
        } catch (aiErr) { console.log('⚠️ AI scan failed — returning Drive link only.', aiErr.message); }
        res.json({ success: true, driveLink: uploadedFile.data.webViewLink, fileId: uploadedFile.data.id, aiData: aiData || {} });
    } catch (error) {
        console.error('❌ Upload/Scan Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 🚀 Start Server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 PRASAD PRO WhatsApp Engine running on port ${PORT}`));
