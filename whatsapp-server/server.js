// @ts-nocheck
// 🟢 PRASAD PRO WhatsApp Engine — hardened for 24/7 local operation.
// Runs on THIS PC (persistent .wwebjs_auth on real disk) — cloud free-tiers
// wipe the session dir on every restart, which is why the old Render deploy
// kept falling back to "WAITING_FOR_SCAN".
//
//  • Auto-reconnect with exponential backoff + a getState() watchdog heartbeat
//  • Frontend-compatible API: GET /api/status/:userId, POST /api/send-whatsapp
//  • USER FOOTPRINT: every outbound message logs WHO sent it (sentByUserId /
//    sentByUserName / timestamp) to wa_chats + wa_logs via
//    the ERP API; incoming replies are logged too so Trip Chat shows both sides.
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const stream = require('stream');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// .env (this folder) — MONGO_URI, WA_ENGINE_TOKEN, PT_BRIDGE_TOKEN etc. live
// here now, never in code. dotenv resolves from the repo root node_modules.
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (e) { /* optional */ }

const app = express();

// 🔐 CORS allowlist (was wide-open `cors()`): only our own front-ends may call
// this engine from a browser. No-Origin callers (curl, server-to-server) pass —
// the token gate + loopback bind below are the real shields for those.
const WA_ALLOWED_ORIGINS = (process.env.WA_ALLOWED_ORIGINS
    || 'https://www.prasadtransport.com,https://prasadtransport.com,http://localhost:5173,http://localhost:4173,capacitor://localhost,http://localhost'
).split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
    origin(origin, cb) {
        if (!origin || WA_ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        secForward({ kind: 'threat', severity: 'low', sensor: 'wa-engine-cors', category: 'cors-denied', message: `Origin not allowed: ${origin}`, action: 'blocked-cors' });
        return cb(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    allowedHeaders: ['Content-Type', 'X-PT-Token'],
}));
app.use(express.json());

// ==========================================
// 🛡️ SOC SENSOR + TOKEN GATE (P0 hardening)
// ==========================================
// Security events forward to the bridge's SOC store (best-effort, never blocks).
const BRIDGE_URL = (process.env.BRIDGE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const BRIDGE_TOKEN = (process.env.PT_BRIDGE_TOKEN || '').split(',')[0].trim();
function secForward(evt) {
    axios.post(`${BRIDGE_URL}/security/ingest`, { ...evt, source: 'prasad' }, {
        headers: BRIDGE_TOKEN ? { 'X-PT-Token': BRIDGE_TOKEN } : {}, timeout: 3000,
    }).catch(() => { /* SOC is observe-only — never break the engine for it */ });
}

// Shared-secret gate (same X-PT-Token pattern as bridge.cjs). Unset = disabled
// (frictionless local dev) — the loopback bind is then the only shield, so SET
// IT if this engine is ever exposed beyond this PC.
const WA_TOKENS = (process.env.WA_ENGINE_TOKEN || '').split(',').map(t => t.trim()).filter(Boolean);
if (!WA_TOKENS.length) console.warn('⚠️  WA_ENGINE_TOKEN not set — engine API is UNAUTHENTICATED (loopback bind is the only shield).');
function requireWaToken(req, res, next) {
    if (!WA_TOKENS.length) return next();
    const s = Buffer.from(req.get('X-PT-Token') || '', 'utf8');
    let ok = false;
    for (const tok of WA_TOKENS) {
        const t = Buffer.from(tok, 'utf8');
        if (s.length === t.length && crypto.timingSafeEqual(s, t)) ok = true;
    }
    if (ok) return next();
    secForward({
        kind: 'threat', severity: req.get('X-PT-Token') ? 'high' : 'med',
        sensor: 'wa-engine-auth', category: req.get('X-PT-Token') ? 'bad-token' : 'missing-token',
        ip: req.socket.remoteAddress || '', method: req.method, path: req.path, action: 'blocked-401',
    });
    return res.status(401).json({ success: false, message: 'Unauthorized: bad or missing X-PT-Token.' });
}
app.use('/api', requireWaToken);
app.use('/upload-to-drive', requireWaToken);

// ==========================================
// 🗒️ AUDIT TRAIL + CHAT HISTORY -> the ERP API
// ==========================================
// Was firebase-admin writing WA_CHATS/WA_LOGS straight to Firestore. The engine
// and the dashboard were two services racing on the same collections with two
// different dedupe rules; now there is one insert path and one rule.
//
// The ERP API is the only writer, and it dedupes on wa_msg_id — which matters
// here specifically: this engine retries sends after a reconnect, and without
// that key a reconnect storm doubled every message in Trip Chat.
//
// Logging must never break a send. Every failure here is swallowed and logged,
// exactly as the Firestore version was.
const ERP_API = process.env.ERP_API_URL || 'http://127.0.0.1:3300';
const CRM_API = `${ERP_API}/api/v1/crm`;

const postCrm = async (path, body) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try {
        const res = await fetch(`${CRM_API}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json().catch(() => ({}));
    } finally { clearTimeout(t); }
};

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

async function logChat(entry) {
    try { await postCrm('/chats', entry); } catch (e) { console.error('WA_CHATS log error:', e.message); }
}
async function logAction(user, action) {
    try { await postCrm('/logs', { user: user || 'System', action }); } catch (e) { /* non-fatal */ }
}

// ==========================================
// 🗄️ LEGACY MONGO (old CRM panel routes) — optional, non-fatal
// ==========================================
// 🔑 P0: credential comes from .env ONLY — the old hardcoded Atlas URI was
// committed to git and that password must be treated as burned (rotate it in
// Atlas; the fallback here is intentionally gone).
const mongoURI = process.env.MONGO_URI || '';
if (mongoURI) {
    mongoose.connect(mongoURI)
        .then(() => console.log('🗄️ Mongo (legacy) connected.'))
        .catch(err => console.log('⚠️ Mongo (legacy) unavailable — legacy CRUD routes disabled:', err.message));
} else {
    console.log('⚠️ MONGO_URI not set — legacy Mongo CRM routes disabled.');
}

const Rule = mongoose.model('Rule', new mongoose.Schema({ keyword: String, reply: String }));
const Contact = mongoose.model('Contact', new mongoose.Schema({
    name: String, phone: String, category: String, company: String, truckNo: String, gst: String, details: String
}));
const Draft = mongoose.model('Draft', new mongoose.Schema({ title: String, content: String }));
const Task = mongoose.model('Task', new mongoose.Schema({ title: String, description: String, status: { type: String, default: 'LEAD' }, phone: String }));
const Signature = mongoose.model('Signature', new mongoose.Schema({ title: String, content: String }));

// ==========================================
// 📲 WHATSAPP ENGINE — one hardened lifecycle, now once PER SESSION
// ==========================================
// WHAT CHANGED AND WHY. There used to be exactly one `client` and one set of
// module-level globals (currentQR / isConnected / engineStatus). /api/status
// took a :userId and ignored it — the comment said "frontend contract" —
// because there was only ever one linked account to report on. `userId` on a
// send was a LABEL for the audit trail, not a choice of sender.
//
// Staff now link their own number, so a session is a first-class thing with its
// own client, its own QR, its own reconnect state and its own auth profile.
//
// THE COMPANY SESSION MUST NOT NOTICE. It keeps WA_CLIENT_ID (`prasad-pro`), so
// .wwebjs_auth/session-prasad-pro is reused and the linked device survives this
// deploy — unlinking it would take down staff OTP login and the password-reset
// codes that ride the same channel. It is still the only session started at
// boot, still the one /api/status answers for, and still the only one that runs
// the Mamta auto-reply.
//
// STAFF SESSIONS ARE LAZY AND CAPPED. Each one is a whole headless Chromium,
// roughly a third of a gigabyte, on a box that also runs the API, the SPA and
// the AI bridge. They start only when somebody asks to link, and WA_MAX_USER_SESSIONS
// bounds how many can be alive at once — refusing the fifth link with a clear
// message is survivable; the API being OOM-killed at 2am is not.
//
// AUTO-REPLY IS COMPANY-ONLY, DELIBERATELY. Mamta answering "hi" is right on
// the company number and completely wrong on a staff member's personal one,
// where the sender is as likely to be their family as a driver.
const COMPANY_SESSION = 'company';
const MAX_USER_SESSIONS = Number.parseInt(process.env.WA_MAX_USER_SESSIONS || '4', 10);
// A staff session with no traffic is memory nobody is using. Stopped, not
// unlinked: the auth profile stays on disk so re-linking needs no new QR scan.
const USER_SESSION_IDLE_MS = Number.parseInt(process.env.WA_USER_IDLE_MS || String(6 * 60 * 60 * 1000), 10);

/** @type {Map<string, object>} sessionId -> session */
const sessions = new Map();

const isCompany = (id) => id === COMPANY_SESSION;
const authIdFor = (id) => (isCompany(id) ? (process.env.WA_CLIENT_ID || 'prasad-pro') : `user-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}`);

function newSession(id) {
    const s = {
        id,
        kind: isCompany(id) ? 'company' : 'user',
        authId: authIdFor(id),
        qr: '',
        connected: false,
        status: 'STARTING',           // STARTING | WAITING_FOR_SCAN | ONLINE | RECONNECTING | OFFLINE
        lastHeartbeat: null,
        reconnectAttempts: 0,
        reinitInFlight: false,
        lastError: null,
        lastActivity: Date.now(),
        client: null,
    };
    s.client = new Client({
        // NAMED SESSION, not the default one.
        //
        // LocalAuth without a clientId writes to .wwebjs_auth/session. That
        // profile went bad on 15-08 and crashed puppeteer during inject on
        // every single boot — "Execution context was destroyed" — which is what
        // took the engine down. Windows still holds open handles inside it, so
        // it cannot be deleted while anything has it mapped; a clientId simply
        // moves us to a clean profile and leaves the bad one sitting there,
        // recoverable, harming nothing. Per-user sessions get their own profile
        // for the same reason, and so one staff member's corrupted session
        // cannot take the company number down with it.
        authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth'), clientId: s.authId }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions', '--disable-gpu'] },
    });
    wireSession(s);
    sessions.set(id, s);
    return s;
}

function getSession(id) { return sessions.get(id || COMPANY_SESSION) || null; }

/** The company session always exists; a staff one is created on demand. */
function ensureSession(id) {
    const existing = sessions.get(id);
    if (existing) return existing;
    if (!isCompany(id)) {
        const live = [...sessions.values()].filter((x) => x.kind === 'user').length;
        if (live >= MAX_USER_SESSIONS) {
            const err = new Error(`Zyada WhatsApp sessions chal rahe hain (limit ${MAX_USER_SESSIONS}). Kisi aur staff ka session band karke dobara try karein.`);
            err.code = 'SESSION_LIMIT';
            throw err;
        }
    }
    return newSession(id);
}

function scheduleReinit(s, reason) {
    if (s.reinitInFlight) return;
    s.reinitInFlight = true;
    s.reconnectAttempts++;
    const delay = Math.min(60000, 3000 * Math.pow(2, Math.min(s.reconnectAttempts - 1, 5))); // 3s → 60s cap
    s.status = 'RECONNECTING';
    console.log(`🔁 [${s.id}] Reconnect #${s.reconnectAttempts} in ${delay / 1000}s (${reason})`);
    setTimeout(async () => {
        try { await s.client.destroy().catch(() => {}); } catch (e) {}
        // initialize() is async: a try/catch around the call catches nothing,
        // because the failure arrives as a rejected promise long after it
        // returns. That is how a browser crash used to kill the whole engine.
        try {
            await s.client.initialize();
        } catch (e) {
            s.lastError = e.message;
            console.error(`[${s.id}] Re-init failed:`, e.message);
            s.reinitInFlight = false;
            return scheduleReinit(s, 're-init failed');
        }
        s.reinitInFlight = false;
    }, delay);
}

function wireSession(s) {
    s.client.on('qr', (qr) => {
        s.qr = qr;
        s.connected = false;
        s.status = 'WAITING_FOR_SCAN';
        console.log(`📲 [${s.id}] New QR generated.`);
    });

    s.client.on('authenticated', () => { console.log(`🔐 [${s.id}] Session authenticated.`); });

    s.client.on('ready', () => {
        s.connected = true;
        s.qr = '';
        s.status = 'ONLINE';
        s.reconnectAttempts = 0;
        s.lastHeartbeat = new Date().toISOString();
        s.lastActivity = Date.now();
        console.log(`✅ [${s.id}] WhatsApp ONLINE & Ready!`);
        logAction('System', `WhatsApp session ${s.id} came ONLINE`);
    });

    s.client.on('auth_failure', (msg) => {
        s.connected = false;
        console.error(`❌ [${s.id}] AUTH FAILURE:`, msg);
        logAction('System', `WhatsApp ${s.id} auth failure: ${msg}`);
        scheduleReinit(s, 'auth_failure');
    });

    s.client.on('disconnected', (reason) => {
        s.connected = false;
        s.qr = '';
        console.log(`❌ [${s.id}] Disconnected! Reason:`, reason);
        logAction('System', `WhatsApp ${s.id} disconnected: ${reason}`);
        scheduleReinit(s, 'disconnected');
    });

    // 🤖 Incoming: log to Trip Chat history, and (company only) auto-reply.
    //
    // EVERY message is posted to the ERP with the session that saw it; the ERP
    // decides what to KEEP. That filter lives there rather than here because
    // deciding "is this number one of ours" needs the drivers, customers and
    // vendors tables, and the engine has none of them. It matters: a staff
    // member's linked personal number receives their private life, and this
    // handler used to write every message it saw straight into wa_chats
    // unconditionally — which is how the company number's group forwards ended
    // up in the books.
    s.client.on('message', async (msg) => {
        try {
            s.lastActivity = Date.now();
            const from10 = last10(msg.from);
            await logChat({
                phone: from10, text: msg.body, type: 'incoming',
                timestamp: new Date().toISOString(), wa_from: msg.from,
                wa_session: s.id, wa_session_kind: s.kind,
            });
            if (s.kind !== 'company') return;   // no bot on a personal number

            const text = msg.body.toLowerCase().trim();
            const rule = await Rule.findOne({ keyword: text }).catch(() => null);
            if (rule) {
                await msg.reply(rule.reply);
                await logChat({ phone: from10, text: rule.reply, type: 'outgoing', userId: 'Mamta AI', sentByUserId: 'mamta-ai-bot', sentByUserName: 'Mamta AI', timestamp: new Date().toISOString(), wa_session: s.id, wa_session_kind: s.kind });
            } else if (text === 'hi' || text === 'hello') {
                const reply = 'नमस्कार! प्रसाद ट्रांसपोर्ट ERP में आपका स्वागत है। मैं Mamta AI हूँ। आपकी क्या सहायता करूँ? 🙏';
                await msg.reply(reply);
                await logChat({ phone: from10, text: reply, type: 'outgoing', userId: 'Mamta AI', sentByUserId: 'mamta-ai-bot', sentByUserName: 'Mamta AI', timestamp: new Date().toISOString(), wa_session: s.id, wa_session_kind: s.kind });
            }
        } catch (err) { console.error(`[${s.id}] Auto-reply Error:`, err); }
    });
}

// 🫀 WATCHDOG HEARTBEAT — every 45s verify each socket is truly alive;
// a hung puppeteer page reports nothing, so we probe getState() ourselves.
setInterval(async () => {
    for (const s of [...sessions.values()]) {
        try {
            const state = await s.client.getState();
            s.lastHeartbeat = new Date().toISOString();
            if (state === 'CONNECTED') {
                if (!s.connected) { s.connected = true; s.status = 'ONLINE'; }
            } else if (s.status !== 'WAITING_FOR_SCAN' && s.status !== 'RECONNECTING') {
                console.log(`🫀 [${s.id}] Heartbeat: state =`, state, '→ scheduling recovery');
                s.connected = false;
                scheduleReinit(s, `heartbeat state ${state}`);
            }
        } catch (e) {
            if (s.status === 'ONLINE') {
                console.log(`🫀 [${s.id}] Heartbeat failed:`, e.message, '→ scheduling recovery');
                s.connected = false;
                scheduleReinit(s, 'heartbeat error');
            }
        }
    }
}, 45000);

// 💤 IDLE REAPER. A staff session nobody has used for hours is a third of a
// gigabyte doing nothing. destroy() frees the Chromium and LEAVES the auth
// profile on disk, so the next link resumes without another QR scan. The
// company session is never reaped — the OTP channel has to be reachable at
// three in the morning without anybody having warmed it up first.
setInterval(() => {
    for (const s of [...sessions.values()]) {
        if (s.kind === 'company') continue;
        if (Date.now() - s.lastActivity < USER_SESSION_IDLE_MS) continue;
        console.log(`💤 [${s.id}] idle — stopping session to free memory`);
        s.client.destroy().catch(() => {});
        sessions.delete(s.id);
    }
}, 15 * 60 * 1000);

// BOOT. Only the company session. Puppeteer fails here more often than anywhere
// else — a half-written session directory, a Chrome that vanished mid-launch, a
// page that navigated while whatsapp-web.js was injecting into it. Every one of
// those arrives as a rejected promise, and an unhandled rejection terminates
// Node. The HTTP server on :5001 died with it, which is why the CRM sat on
// "server connecting..." forever: it was polling a process that no longer
// existed.
const companySession = newSession(COMPANY_SESSION);
companySession.client.initialize().catch((e) => {
    companySession.lastError = e.message;
    console.error('Initial launch failed:', e.message);
    scheduleReinit(companySession, 'initial launch failed');
});

// LAST RESORT. Anything that escapes the handlers above must not take the API
// down with it. A dead engine that can still answer /api/status with OFFLINE is
// recoverable from the UI; a dead process is not.
//
// These are process-wide and cannot tell which session threw, so they recover
// the company one — the session whose death actually stops the firm working.
process.on('unhandledRejection', (err) => {
    const msg = err && err.message ? err.message : String(err);
    companySession.lastError = msg;
    console.error('⚠  Unhandled rejection (engine stays up):', msg);
    if (companySession.status !== 'WAITING_FOR_SCAN') { companySession.connected = false; scheduleReinit(companySession, 'unhandled rejection'); }
});
process.on('uncaughtException', (err) => {
    companySession.lastError = err.message;
    console.error('⚠  Uncaught exception (engine stays up):', err.message);
    if (companySession.status !== 'WAITING_FOR_SCAN') { companySession.connected = false; scheduleReinit(companySession, 'uncaught exception'); }
});

// ==========================================
// 🌐 API ROUTES
// ==========================================
const statusPayload = (s) => ({
    connected: s ? s.connected : false,
    qr: s ? s.qr : '',
    status: s ? s.status : 'OFFLINE',
    lastHeartbeat: s ? s.lastHeartbeat : null,
    reconnectAttempts: s ? s.reconnectAttempts : 0,
    server: 'local-pc',
    // "Offline" on its own tells an operator nothing they can act on.
    lastError: s ? s.lastError : 'session not started',
    uptimeSec: Math.round(process.uptime()),
    session: s ? s.id : null,
    session_kind: s ? s.kind : null,
});

app.get('/api/status', (req, res) => res.json(statusPayload(getSession(COMPANY_SESSION))));

// :userId NOW MEANS SOMETHING. It used to be accepted and thrown away — the
// comment on the old line said "frontend contract" — because one linked account
// was all there was. A staff member who has never linked gets a payload that
// says so rather than the company session's state, which would have told them
// they were online on a number they had never scanned.
app.get('/api/status/:userId', (req, res) => {
    const id = req.params.userId;
    res.json(statusPayload(getSession(id) || (id === COMPANY_SESSION ? getSession(COMPANY_SESSION) : null)));
});

app.get('/api/sessions', (req, res) => {
    res.json({
        max_user_sessions: MAX_USER_SESSIONS,
        sessions: [...sessions.values()].map((s) => ({
            id: s.id, kind: s.kind, status: s.status, connected: s.connected,
            lastHeartbeat: s.lastHeartbeat, idleMs: Date.now() - s.lastActivity,
        })),
    });
});

// 🔗 LINK — start a session and hand back its QR.
//
// Idempotent on purpose: the linking screen polls this, and a second call while
// a scan is pending must return the SAME pending QR rather than tearing the
// client down and issuing a new one, which is what makes a QR flicker
// unscannable.
app.post('/api/link/:userId', async (req, res) => {
    const id = req.params.userId;
    try {
        let s = getSession(id);
        if (!s) {
            s = ensureSession(id);
            s.client.initialize().catch((e) => {
                s.lastError = e.message;
                console.error(`[${id}] Initial launch failed:`, e.message);
                scheduleReinit(s, 'initial launch failed');
            });
        }
        s.lastActivity = Date.now();
        res.json({ success: true, ...statusPayload(s) });
    } catch (e) {
        res.status(e.code === 'SESSION_LIMIT' ? 429 : 500).json({ success: false, message: e.message, code: e.code || null });
    }
});

// 💬 SEND — routed to the SENDER'S OWN session when they have one.
//
// `userId` used to be nothing but a label stamped on the audit trail; the
// message always left the company number. It now selects the client, and falls
// back to the company session when that staff member has not linked — a
// dispatch message must still go out, from the company number, rather than fail
// because somebody never scanned a QR.
async function doSend({ number, message, userId, sentByUserId, sentByUserName, tripId, role, sessionId }) {
    const wanted = sessionId || userId;
    let s = wanted ? getSession(wanted) : null;
    if (!s || !s.connected) s = getSession(COMPANY_SESSION);
    if (!s || !s.connected) throw new Error('WhatsApp engine OFFLINE — Link WhatsApp tab se QR scan karein.');

    let formatted = String(number || '').replace(/\D/g, '');
    if (formatted.length === 10) formatted = `91${formatted}`;
    if (formatted.length < 11) throw new Error('Invalid phone number');
    const chatId = `${formatted}@c.us`;
    const sent = await s.client.sendMessage(chatId, message);
    s.lastActivity = Date.now();
    const senderName = sentByUserName || userId || 'Unknown';
    await logChat({
        phone: last10(formatted), text: message, type: 'outgoing',
        userId: senderName,                       // legacy badge field
        sentByUserId: sentByUserId || senderName, // 👣 USER FOOTPRINT
        sentByUserName: senderName,
        tripId: tripId || null, role: role || null,
        timestamp: new Date().toISOString(),
        wa_msg_id: sent?.id?._serialized || null,
        wa_session: s.id, wa_session_kind: s.kind,
    });
    await logAction(senderName, `Sent WhatsApp to ${last10(formatted)} via ${s.id}${tripId ? ` (Trip ${tripId})` : ''}`);
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

// 🔌 LOGOUT — unlink one session. Without a userId this is the company number,
// which is what the old single-session callers meant, so they keep working.
//
// A user session is REMOVED from the registry after logout: its auth profile is
// gone, so keeping a client around would only sit there generating a QR nobody
// asked for.
app.post('/api/logout', async (req, res) => {
    const id = req.body?.sessionId || req.body?.targetUserId || COMPANY_SESSION;
    const s = getSession(id);
    if (!s) return res.status(404).json({ success: false, message: 'That WhatsApp session is not linked.' });
    try {
        await s.client.logout();
        s.connected = false;
        s.qr = '';
        s.status = 'WAITING_FOR_SCAN';
        logAction(req.body?.userId || 'Admin', `Logged out WhatsApp session ${id}`);
        res.json({ success: true, message: 'Logged out successfully' });
        if (isCompany(id)) scheduleReinit(s, 'manual logout');
        else { s.client.destroy().catch(() => {}); sessions.delete(id); }
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
// 🔒 P0 LOCKDOWN: loopback by default — the ERP frontend calls this engine as
// http://localhost:5001 from THIS PC, so nothing legitimate breaks; the LAN /
// internet can no longer reach it. Set HOST=0.0.0.0 only deliberately.
const PORT = process.env.PORT || 5001;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`🚀 PRASAD PRO WhatsApp Engine running on ${HOST}:${PORT}`));
