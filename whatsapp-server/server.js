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
const fs = require('fs');
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

// The ERP closed its API by default (server/index.js). This engine is not a
// person and has no session, so it identifies as a machine with the shared
// service secret — the same door POST /finance/vouchers already uses for the
// unattended IOCL reconciler.
//
// Sent only when configured. The ERP keeps these two ingest routes open while
// no ERP_SERVICE_TOKEN is set precisely so that an engine deployed before the
// secret exists keeps recording rather than silently dropping every message;
// setting it on both sides is what closes them.
const SERVICE_TOKEN = process.env.ERP_SERVICE_TOKEN || '';

const postCrm = async (path, body) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try {
        const res = await fetch(`${CRM_API}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(SERVICE_TOKEN ? { Authorization: `Bearer ${SERVICE_TOKEN}`, 'X-Service-Name': 'whatsapp-engine' } : {}),
            },
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
// ONE, NOT FOUR, AND THE NUMBER WAS MEASURED.
//
// This defaulted to 4 on the guess that a session was "about 300MB". On the
// production box it is closer to 10 Chromium processes and ~200-250MB EACH, and
// that box is a t3.small: 1905MB total, with the API, the SPA server, the AI
// bridge and Postgres already on it. With the company session plus two stray
// user sessions alive it sat at 158MB free and 34 Chromium processes, and
// Chromium started losing tabs under the pressure — which surfaces as
// "Target closed" and "Execution context was destroyed", and is why
// requestPairingCode was failing. Four would have taken the box down.
//
// One user session at a time is what 2GB actually holds. Raise
// WA_MAX_USER_SESSIONS on a bigger host; the default has to be the number that
// is safe on the smallest one it runs on.
const MAX_USER_SESSIONS = Number.parseInt(process.env.WA_MAX_USER_SESSIONS || '1', 10);
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
        pairingCode: '',
        pairPhone: '',
        // Pairing is asked for ONCE and then left alone — see askForPairingCode.
        // `pairAsked` is what makes a rotating QR stop re-arming it, `pairInFlight`
        // stops two chains overlapping, and `pairingError` is the sentence the
        // operator sees instead of a silent fall back to a QR they cannot scan.
        pairAsked: false,
        pairInFlight: false,
        pairCooldownUntil: 0,
        pairingError: null,
        pairingCodeAt: 0,
        pairRefreshTimer: null,
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
        // LEAN FLAGS, BECAUSE THE BOX HAS 2GB AND CHROMIUM DOES NOT CARE.
        //
        // --disable-dev-shm-usage is the one everybody reaches for first. It is
        // kept because it is free insurance, but it was NOT the fault here:
        // /dev/shm on this host is 953M with 1.1M in use. The pressure was plain
        // RAM. The rest of these turn off subsystems a headless WhatsApp session
        // never uses and which each cost memory and wakeups.
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-accelerated-2d-canvas',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-breakpad',
                '--disable-sync',
                '--no-first-run',
                '--no-default-browser-check',
                '--mute-audio',
            ],
        },
    });
    wireSession(s);
    sessions.set(id, s);
    return s;
}

function getSession(id) { return sessions.get(id || COMPANY_SESSION) || null; }

/** THROW AWAY A DEAD AUTH PROFILE.
 *
 *  LocalAuth writes to <dataPath>/session-<clientId>. Two states put a profile
 *  in there that can never link again, and reusing either one produces the same
 *  loop: a QR appears, the phone scans it, WhatsApp answers LOGOUT, the client
 *  reconnects with the same dead credentials and offers another QR. Observed on
 *  the box 28-08 — the owner scanned, the phone said "Logging in…", and the
 *  screen went back to a fresh QR every twenty seconds.
 *
 *  1. A LOGOUT/UNPAIRED disconnect. WhatsApp is saying the registration is
 *     gone. Keeping the folder keeps a credential the server has just been told
 *     is void.
 *  2. A session reaped before it ever linked. The idle reaper's note says
 *     destroy() "LEAVES the auth profile on disk, so the next link resumes
 *     without another QR scan" — true, and right, for a session that DID link.
 *     For one that never did there is nothing to resume; what is left is a
 *     half-written profile, and it is what the next scan collides with.
 *
 *  Best-effort by design. A folder we cannot delete (Windows keeps handles open
 *  inside it) must not stop the reconnect — the clientId still moves us to a
 *  clean directory on the next launch, which is the whole reason sessions are
 *  named rather than sharing LocalAuth's default. */
function wipeAuthProfile(s, why) {
    const dir = path.join(__dirname, '.wwebjs_auth', `session-${s.authId}`);
    try {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`🧹 [${s.id}] Cleared auth profile (${why}) — next link starts from a clean scan.`);
    } catch (e) {
        console.error(`[${s.id}] Could not clear auth profile (${why}):`, e.message);
    }
}

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
        // BOTH CREDENTIALS DIE WITH THE PAGE. The QR and the pairing code are
        // renderings of an auth ref that belongs to the Chromium being thrown
        // away here. Left in place they keep being served to the screen, and a
        // dead code typed into a phone answers "Couldn't link device" — which
        // reads as the link being broken rather than the code being old.
        clearPairingRefresh(s);
        s.qr = '';
        s.pairingCode = '';
        try { await s.client.destroy().catch(() => {}); } catch (e) {}
        // AFTER destroy, BEFORE initialize — the only safe window there is.
        // Deleting the folder while Chromium still has it open lets the
        // shutdown flush session state straight back onto what we just
        // removed, which puts the dead credential back and reopens the exact
        // loop this is here to end.
        if (s.wipeOnReinit) { s.wipeOnReinit = false; wipeAuthProfile(s, 'dead credential'); }
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

/** ASKING WHATSAPP FOR THE CODE — AND WHY ASKING TWICE IS WORSE THAN NOT ASKING.
 *
 *  WhatsApp rate-limits pairing requests per number, and the limit is not
 *  generous. Once tripped, every later call is refused for a while — and the
 *  refusal arrives as a minified error object whose whole text is one letter:
 *
 *      requestPairingCode attempt 3 failed: t
 *
 *  That one letter is the reason this used to look like a bug in the code
 *  rather than a wall we had walked into. Measured on the box 28-08 with the
 *  previous version of this file: SIX chains running at once, ~18 requests a
 *  minute, every one answered `t`.
 *
 *  All three multipliers are fixed here.
 *
 *  ONE CHAIN. `qr` fires again roughly every 20 seconds — WhatsApp rotates the
 *  code — and the old guard (`!s.pairingCode`) is true the entire time a
 *  request is failing, so every rotation started ANOTHER six-attempt chain on
 *  top of the ones already running. `pairInFlight` is the guard that `pairingCode`
 *  could not be, because it describes the request rather than its result.
 *
 *  TRANSIENT ONLY. The library's own hook — window.onCodeReceivedEvent — is
 *  installed during page injection, so firing on the first `qr` genuinely does
 *  race it, and THAT is worth a retry. A refusal from WhatsApp is not: it will
 *  be refused again, and each retry digs the hole deeper. Only errors that name
 *  the injection are retried now.
 *
 *  THEN STOP, AND SAY SO. Giving up sets a cooldown and a sentence the operator
 *  can act on. Nothing re-arms by itself; the next attempt is a person pressing
 *  the button, which is also the only signal that anyone is still watching. */
const PAIR_COOLDOWN_MS = Number.parseInt(process.env.WA_PAIR_COOLDOWN_MS || String(20 * 60 * 1000), 10);

/** A PAIRING CODE HAS A SHELF LIFE, AND THE FIRST FIX FORGOT IT.
 *
 *  The QR and the code are two renderings of the same auth ref, and the page
 *  rotates that ref every ~20 seconds. whatsapp-web.js keeps the displayed code
 *  usable by re-requesting it on a timer — `window.codeInterval`, default 180s —
 *  and this morning's fix deliberately removed that, calling it a second
 *  uninvited caller against the rate limit we had just walked into.
 *
 *  Half right. It IS a second caller, and stacking it under six overlapping
 *  retry chains is what got us blocked. But on its own it is one request every
 *  three minutes, and it is the only thing keeping the code on screen alive.
 *  Without it the code was issued once and then sat there going stale:
 *
 *      02:37:17  🔢 Pairing code issued (attempt 1)
 *      02:38:15  📲 New QR generated          … and every 20s after
 *      08:11     phone: "Couldn't link device"
 *
 *  Four minutes between issue and entry, and the code had been dead for most of
 *  them. So the refresh comes back — at WhatsApp's own cadence, as ONE timer,
 *  behind the same single-chain guard as everything else. 170s rather than 180
 *  so the replacement is in hand slightly before the old one lapses. */
const PAIR_REFRESH_MS = Number.parseInt(process.env.WA_PAIR_REFRESH_MS || String(170 * 1000), 10);

/** Cancel any pending refresh. Called wherever a session stops needing a code —
 *  it linked, it was logged out, it was reaped, or its page is being replaced. */
function clearPairingRefresh(s) {
    if (s && s.pairRefreshTimer) { clearTimeout(s.pairRefreshTimer); s.pairRefreshTimer = null; }
}

function schedulePairingRefresh(s) {
    clearPairingRefresh(s);
    s.pairRefreshTimer = setTimeout(() => {
        s.pairRefreshTimer = null;
        if (!sessions.has(s.id) || s.connected || !s.pairPhone) return;
        // Dropped BEFORE asking, not after. Leaving the old one in place would
        // keep the guard at the top of askForPairingCode shut, and would also
        // leave a dead code on the operator's screen for the second or two the
        // request takes — which is the exact failure being fixed.
        s.pairingCode = '';
        askForPairingCode(s);
    }, PAIR_REFRESH_MS);
}

/** A transient failure is one that names the library's own injection. Anything
 *  else came from WhatsApp and means what it says. */
const isTransientPairError = (msg) => /onCodeReceivedEvent|PairingCodeLinkUtils|not a function|undefined/i.test(msg || '');

/** THE ERROR, NOT ITS INITIAL. whatsapp-web.js calls startAltLinkingFlow inside
 *  a page.evaluate, and an exception crossing that boundary is flattened to
 *  whatever `message` survived minification — here, `t`. Running the same three
 *  calls ourselves with a try/catch INSIDE the page lets the real shape of the
 *  error come back as data: name, message, and the string form, none of which
 *  survive the throw.
 *
 *  It is the same flow the library runs, in the same order, so this is not a
 *  reimplementation of the protocol — it is the library's own evaluate with the
 *  catch moved to the side of the boundary where the error still exists. The one
 *  deliberate omission is window.codeInterval: the library re-requests every 180
 *  seconds for the life of the page, which is a second uninvited caller against
 *  the same rate limit. A code that expires is better re-requested by a person. */
async function issuePairingCode(client, phone) {
    return client.pupPage.evaluate(async (phoneNumber, showNotification) => {
        const describe = (e) => {
            const out = { name: null, message: null, code: null, text: String(e) };
            try { out.name = e && e.name ? String(e.name) : null; } catch { /* getter threw */ }
            try { out.message = e && e.message ? String(e.message) : null; } catch { /* getter threw */ }
            try { out.code = e && e.code != null ? String(e.code) : null; } catch { /* getter threw */ }
            // Minified WhatsApp errors often carry their meaning in own
            // properties rather than in `message`, so keep them.
            try { out.own = JSON.stringify(e, Object.getOwnPropertyNames(Object(e))).slice(0, 400); } catch { /* circular */ }
            return out;
        };
        try {
            const deadline = Date.now() + 20000;
            while (!window.AuthStore || !window.AuthStore.PairingCodeLinkUtils) {
                if (Date.now() > deadline) return { ok: false, err: { message: 'PairingCodeLinkUtils never appeared', text: 'timeout' } };
                await new Promise((r) => setTimeout(r, 250));
            }
            window.AuthStore.PairingCodeLinkUtils.setPairingType('ALT_DEVICE_LINKING');
            await window.AuthStore.PairingCodeLinkUtils.initializeAltDeviceLinking();
            const code = await window.AuthStore.PairingCodeLinkUtils.startAltLinkingFlow(phoneNumber, showNotification);
            return { ok: true, code: String(code || '') };
        } catch (e) {
            return { ok: false, err: describe(e) };
        }
    }, phone, true);
}

function askForPairingCode(s, attempt = 0) {
    if (!s || s.pairingCode || s.connected || !s.pairPhone) return;
    if (!sessions.has(s.id)) return;                 // logged out while waiting
    if (s.pairInFlight) return;                      // a chain is already running
    if (s.pairCooldownUntil && Date.now() < s.pairCooldownUntil) return;
    s.pairAsked = true;
    if (attempt >= 3) {
        s.pairInFlight = false;
        s.pairCooldownUntil = Date.now() + PAIR_COOLDOWN_MS;
        s.pairingError = 'WhatsApp abhi code nahi de raha. QR se jodein, ya thodi der baad dobara koshish karein.';
        s.lastError = s.pairingError;
        console.error(`[${s.id}] pairing code gave up after ${attempt} attempts; cooling down ${Math.round(PAIR_COOLDOWN_MS / 60000)}m`);
        return;
    }
    s.pairInFlight = true;
    issuePairingCode(s.client, s.pairPhone)
        .then((r) => {
            s.pairInFlight = false;
            if (!sessions.has(s.id) || s.connected) return;
            if (r && r.ok && r.code) {
                s.pairingCode = r.code;
                s.pairingCodeAt = Date.now();
                s.pairingError = null;
                s.lastError = null;
                s.pairCooldownUntil = 0;
                // Keep it alive. A code nobody refreshes is a code that works
                // for whoever types it inside three minutes and nobody else.
                schedulePairingRefresh(s);
                console.log(`🔢 [${s.id}] Pairing code issued (attempt ${attempt + 1}); refresh in ${Math.round(PAIR_REFRESH_MS / 1000)}s.`);
                return;
            }
            const err = (r && r.err) || {};
            // Logged whole, because the whole point of issuePairingCode is that
            // the interesting part is never in `message`.
            const detail = err.message || err.text || 'unknown';
            console.error(`[${s.id}] pairing attempt ${attempt + 1} refused:`, JSON.stringify(err).slice(0, 400));
            if (isTransientPairError(detail) || isTransientPairError(err.own)) {
                // The library's injection has not finished. Worth one more go.
                s.lastError = `pairing code: engine abhi taiyar nahi (${detail})`;
                setTimeout(() => askForPairingCode(s, attempt + 1), 4000 + attempt * 4000);
                return;
            }
            // WhatsApp said no. Asking again is what got us here.
            s.pairCooldownUntil = Date.now() + PAIR_COOLDOWN_MS;
            s.pairingError = 'WhatsApp ne abhi code dene se mana kar diya — aam taur par bahut zyada koshish ho jane par. QR se abhi jud sakte hain, ya ~20 minute baad dobara.';
            s.lastError = `${s.pairingError} [${detail}]`;
        })
        .catch((e) => {
            // The evaluate itself failed — a dead page, not a refusal. That is
            // the "Target closed" case, and it is the session that is broken.
            s.pairInFlight = false;
            const msg = e && e.message ? e.message : String(e);
            console.error(`[${s.id}] pairing evaluate failed:`, msg);
            s.pairingError = 'WhatsApp engine ka page band ho gaya — dobara koshish karein.';
            s.lastError = `pairing evaluate failed: ${msg}`;
        });
}

function wireSession(s) {
    s.client.on('qr', (qr) => {
        s.qr = qr;
        s.connected = false;
        s.status = 'WAITING_FOR_SCAN';
        console.log(`📲 [${s.id}] New QR generated.`);

        // ── PAIRING CODE — THE ONLY "NO QR" LINK WHATSAPP ACTUALLY ALLOWS ──
        //
        // A number matching a staff row proves nothing to WhatsApp. Only the
        // account holder approving from their own handset is authentication,
        // and no server-side API skips that — not an official one, not this
        // library. What CAN be skipped is the CAMERA: requestPairingCode
        // returns an 8-character code the person types into WhatsApp → Link a
        // device → "Link with phone number instead".
        //
        // On a phone that is the only workable flow anyway: you cannot scan a
        // QR that is being drawn on the same screen you are holding.
        //
        // Requested HERE, not at link time, because the client can only issue
        // one once it has reached the auth screen — which is precisely what
        // this event means. And requested ONCE per pending session: asking
        // again invalidates the code already sitting on the operator's screen,
        // and the link endpoint is polled.
        //
        // ONCE MEANS `pairAsked`, NOT `!pairingCode`. This event repeats every
        // ~20 seconds for as long as nobody links, and while a request is
        // FAILING there is no pairingCode to hold the old guard shut — so each
        // rotation started a fresh retry chain on top of the last, and the
        // stack of them is what tripped WhatsApp's rate limit. One ask per
        // session; after that only a person pressing the button starts another.
        if (s.pairPhone && !s.pairingCode && !s.pairAsked) {
            askForPairingCode(s);
        }
    });

    s.client.on('authenticated', () => { console.log(`🔐 [${s.id}] Session authenticated.`); });

    s.client.on('ready', () => {
        s.connected = true;
        s.qr = '';
        // Both link credentials die with the link. A pairing code left on a
        // screen after the session is ONLINE gets typed in and fails, which
        // reads as "the link broke" when it actually worked.
        s.pairingCode = '';
        s.pairPhone = '';
        // The pairing bookkeeping dies with the link too. A cooldown left set
        // here would be waiting out a limit for a session that has since
        // succeeded, and an error string left set would be shown next to a
        // working link.
        s.pairAsked = false;
        s.pairInFlight = false;
        s.pairCooldownUntil = 0;
        s.pairingError = null;
        clearPairingRefresh(s);
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

        // LOGOUT IS NOT A NETWORK BLIP, AND RECONNECTING THROUGH IT IS A LOOP.
        //
        // These two reasons mean WhatsApp has voided the registration: the
        // phone unlinked the device, or the stored credential collided with a
        // new scan. Reconnecting reuses the same folder, so the client comes
        // back up, shows a QR, the person scans it, and WhatsApp answers LOGOUT
        // again. That is precisely what the box logged this morning — a scan at
        // 02:04:17, LOGOUT in the same second, and a fresh QR every twenty
        // seconds from then on, with the phone stuck on "Logging in…".
        //
        // Clearing the profile first costs a scan and is the only thing that
        // ends it. Said out loud for the company line, because that one is the
        // OTP channel and somebody has to go and scan it.
        const dead = ['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE'].includes(String(reason).toUpperCase());
        if (dead) {
            s.pairingCode = '';
            s.pairAsked = false;
            s.pairCooldownUntil = 0;
            // Flagged rather than done here: scheduleReinit destroys the client
            // first, and a wipe before that shutdown gets undone by it.
            s.wipeOnReinit = true;
            if (isCompany(s.id)) {
                logAction('System', 'COMPANY WhatsApp was logged out — a QR re-scan is needed before OTP works again.');
            }
        }
        scheduleReinit(s, dead ? `disconnected ${reason} (profile cleared)` : 'disconnected');
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
// A session that never LINKED is reaped far sooner than one that did. Somebody
// who opened the dialog, saw the code and wandered off leaves a full Chromium
// pinned at WAITING_FOR_SCAN — and on a 2GB box that is a quarter of the RAM
// held for six hours by a link that is not going to happen. It also occupies the
// single user slot, so the next person to try is told the limit is reached
// because of somebody else's abandoned tab. Ten minutes is longer than any real
// person takes to type eight characters into their phone.
const PENDING_LINK_TIMEOUT_MS = Number.parseInt(process.env.WA_PENDING_TIMEOUT_MS || String(10 * 60 * 1000), 10);

setInterval(() => {
    for (const s of [...sessions.values()]) {
        if (s.kind === 'company') continue;
        const idle = Date.now() - s.lastActivity;
        const limit = s.connected ? USER_SESSION_IDLE_MS : PENDING_LINK_TIMEOUT_MS;
        if (idle < limit) continue;
        console.log(`💤 [${s.id}] ${s.connected ? 'idle' : 'never linked'} for ${Math.round(idle / 60000)}m — stopping session to free memory`);
        // KEEP THE PROFILE ONLY IF THERE IS SOMETHING TO RESUME. The note above
        // is right that leaving it lets a LINKED session come back without
        // another scan. A session that never linked has no credential to keep —
        // only the half-written directory its abandoned launch left behind, and
        // that is what the NEXT scan collides with. Two of those were sitting on
        // this box (reaped 00:44 and 01:38) when the 02:04 scan was answered
        // with LOGOUT.
        //
        // Chained after destroy for the same reason the reinit path is: the
        // shutdown writes, so wiping first only means wiping twice.
        const neverLinked = !s.connected;
        clearPairingRefresh(s);
        s.client.destroy()
            .catch(() => {})
            .then(() => { if (neverLinked) wipeAuthProfile(s, 'reaped before it ever linked'); });
        sessions.delete(s.id);
    }
}, 2 * 60 * 1000);

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
// These are process-wide and CANNOT TELL WHICH SESSION THREW. They used to
// answer that by restarting the company one regardless — reasonable when the
// company line was the only session there was, and actively harmful now.
//
// Measured on the box 28-08. A staff member's link attempt failed, its teardown
// rejected, and this handler took the COMPANY session down with it:
//
//     02:04:17  ❌ [u8f51…] Disconnected! Reason: LOGOUT
//     02:04:22  🔁 [company] Reconnect #1 in 3s (unhandled rejection)
//     02:04:43  ✅ [company] WhatsApp ONLINE & Ready!
//
// Twenty-six seconds with no OTP channel and no dispatch, caused by somebody
// else's failed QR scan. Every driver login goes through that line.
//
// So these now RECORD and stop. Recovery belongs to the watchdog heartbeat 45
// seconds below, which probes each session's real state with getState() and
// restarts the one that is actually dead — evidence rather than a guess. The
// original worry stands and is still handled: the process stays up, and a live
// engine answering OFFLINE is recoverable from the UI where a dead one is not.
process.on('unhandledRejection', (err) => {
    const msg = err && err.message ? err.message : String(err);
    companySession.lastError = msg;
    console.error('⚠  Unhandled rejection (engine stays up, heartbeat will recover any dead session):', msg);
});
process.on('uncaughtException', (err) => {
    companySession.lastError = err.message;
    console.error('⚠  Uncaught exception (engine stays up, heartbeat will recover any dead session):', err.message);
});

// ==========================================
// 🌐 API ROUTES
// ==========================================
const statusPayload = (s) => ({
    connected: s ? s.connected : false,
    qr: s ? s.qr : '',
    pairingCode: s ? s.pairingCode : '',
    status: s ? s.status : 'OFFLINE',
    lastHeartbeat: s ? s.lastHeartbeat : null,
    reconnectAttempts: s ? s.reconnectAttempts : 0,
    server: 'local-pc',
    // "Offline" on its own tells an operator nothing they can act on.
    lastError: s ? s.lastError : 'session not started',
    // SEPARATE FROM lastError ON PURPOSE. lastError is a developer's field —
    // it collects reconnects, auth failures and evaluate crashes — and the ERP
    // must not put whatever happens to be in it in front of an operator. This
    // one is set only by the pairing path and only with a sentence written to
    // be read, so the ERP can pass it straight through to the screen.
    pairingError: s ? (s.pairingError || null) : null,
    // Lets the screen say "20 minute baad" rather than "later".
    pairingRetryInSec: s && s.pairCooldownUntil && s.pairCooldownUntil > Date.now()
        ? Math.ceil((s.pairCooldownUntil - Date.now()) / 1000) : 0,
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
        // OPTIONAL `phone` — ask for a pairing code instead of a QR.
        //
        // The ERP sends the caller's OWN registered mobile, read from their
        // user row, never from the browser. It is a routing hint for WhatsApp,
        // not a claim of identity: the person still has to type the code into
        // the app on the handset that owns the number, so a wrong or forged
        // number produces a code nobody can use rather than somebody else's
        // account. Absent, the session behaves exactly as before and shows a QR.
        let phone = String(req.body?.phone || '').replace(/\D/g, '');
        if (phone.length === 10) phone = `91${phone}`;
        if (phone && phone.length < 11) {
            return res.status(400).json({ success: false, message: 'Invalid phone number', code: 'BAD_PHONE' });
        }

        let s = getSession(id);
        if (!s) {
            s = ensureSession(id);
            if (phone) s.pairPhone = phone;
            s.client.initialize().catch((e) => {
                s.lastError = e.message;
                console.error(`[${id}] Initial launch failed:`, e.message);
                scheduleReinit(s, 'initial launch failed');
            });
        } else if (phone && !s.connected && !s.pairingCode) {
            // Session already up and waiting. It has passed the 'qr' event, so
            // nothing will re-fire to trigger the request — do it here. Still
            // guarded on !pairingCode: this endpoint is POLLED, and a second
            // request would invalidate the code already on screen.
            s.pairPhone = phone;
            // AND GUARDED ON `pairAsked` TOO, FOR THE SAME REASON THE 'qr'
            // HANDLER IS. A poll arriving in the gap between two retries finds
            // pairInFlight false and would start a second chain beside the one
            // already going. A person pressing the button again is a real
            // retry and must still work — that is the cooldown branch, which
            // becomes true only once the previous chain has finished and its
            // cooling-off period has passed.
            const cooledOff = !s.pairCooldownUntil || Date.now() >= s.pairCooldownUntil;
            if (s.status === 'WAITING_FOR_SCAN' && (!s.pairAsked || (cooledOff && !s.pairInFlight))) {
                askForPairingCode(s);
            }
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
