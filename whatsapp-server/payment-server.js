const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

// .env (this folder) — Cashfree keys + PAYOUT_ADMIN_KEY live here, never in code.
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (e) { /* optional */ }

const app = express();

// 🔐 CORS allowlist — only our own front-ends from a browser.
const ALLOWED_ORIGINS = (process.env.WA_ALLOWED_ORIGINS
    || 'https://www.prasadtransport.com,https://prasadtransport.com,http://localhost:5173,http://localhost:4173,capacitor://localhost,http://localhost'
).split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
    origin(origin, cb) {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    allowedHeaders: ['Content-Type', 'X-Admin-Key'],
}));
app.use(express.json());

// 🛡️ SOC sensor — auth failures forward to the bridge radar (best-effort).
const BRIDGE_URL = (process.env.BRIDGE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const BRIDGE_TOKEN = (process.env.PT_BRIDGE_TOKEN || '').split(',')[0].trim();
function secForward(evt) {
    axios.post(`${BRIDGE_URL}/security/ingest`, { ...evt, source: 'prasad' }, {
        headers: BRIDGE_TOKEN ? { 'X-PT-Token': BRIDGE_TOKEN } : {}, timeout: 3000,
    }).catch(() => { /* observe-only */ });
}

// 🔑 Cashfree API keys — .env ONLY (जब KYC अप्रूव हो जाए, .env में डालें)
const CASHFREE_CLIENT_ID = process.env.CASHFREE_CLIENT_ID || '';
const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET || '';

// 🌐 Production (Live) API URL for Cashfree Payouts
const BASE_URL = 'https://payout-api.cashfree.com/payout/v1';

// 🔒 P0 AUTH GUARD (Prasad's "squareoff" equivalent — real money moves here).
// FAIL-CLOSED by design: no PAYOUT_ADMIN_KEY configured → endpoint is disabled.
// (Jaiswal's squareoff guard is fail-open because it is an EXIT/safety path;
// a payout is the opposite — money leaving the company must never be easier
// to trigger because of a config gap.)
const PAYOUT_ADMIN_KEY = process.env.PAYOUT_ADMIN_KEY || '';
if (!PAYOUT_ADMIN_KEY) console.warn('⚠️  PAYOUT_ADMIN_KEY not set — /api/payout is DISABLED (fail-closed).');
function requirePayoutKey(req, res, next) {
    if (!PAYOUT_ADMIN_KEY) {
        return res.status(503).json({ success: false, message: 'Payout disabled: PAYOUT_ADMIN_KEY not configured.' });
    }
    const s = Buffer.from(req.get('X-Admin-Key') || '', 'utf8');
    const t = Buffer.from(PAYOUT_ADMIN_KEY, 'utf8');
    if (s.length === t.length && crypto.timingSafeEqual(s, t)) return next();
    secForward({
        kind: 'threat', severity: 'critical', sensor: 'payout-auth', category: 'payout-unauthorized',
        ip: req.socket.remoteAddress || '', method: req.method, path: req.path,
        message: 'Unauthorized bank-payout attempt', action: 'blocked-401',
    });
    return res.status(401).json({ success: false, message: 'Unauthorized: X-Admin-Key required.' });
}

// 🚀 API PAYOUT ROUTE (ERP से पैसा भेजने के लिए)
app.post('/api/payout', requirePayoutKey, async (req, res) => {
    if (!CASHFREE_CLIENT_ID || !CASHFREE_CLIENT_SECRET) {
        return res.status(503).json({ success: false, message: 'Payout disabled: Cashfree keys not configured (.env).' });
    }
    const { amount, name, account_no, ifsc, narration, phone } = req.body;
    const transferId = `TRF_${Date.now()}`; // हर पेमेंट का एक यूनीक ID

    try {
        // STEP 1: Cashfree से Secure Token (चाबी) मांगना
        const authResponse = await axios.post(`${BASE_URL}/authorize`, {}, {
            headers: {
                'x-client-id': CASHFREE_CLIENT_ID,
                'x-client-secret': CASHFREE_CLIENT_SECRET
            }
        });

        const token = authResponse.data.data.token;

        // STEP 2: Direct Bank Transfer (असली पैसा भेजना)
        const transferResponse = await axios.post(`${BASE_URL}/requestTransfer`, {
            beneficiaryDetails: {
                beneficiaryName: name,
                beneficiaryAccount: account_no,
                beneficiaryIFSC: ifsc,
                beneficiaryEmail: "erp@prasadtransport.com",
                beneficiaryPhone: phone || "9999999999",
                address1: "India"
            },
            transferId: transferId,
            transferMode: "IMPS", // IMPS (Turant transfer 24x7)
            transferAmount: amount,
            remarks: narration || "Prasad ERP Payout"
        }, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        // ✅ Payment Success! ERP को UTR नंबर भेजना
        res.json({
            success: true,
            utr: transferResponse.data.data.utr || transferResponse.data.data.referenceId,
            transferId: transferId,
            message: "Transfer Successful!"
        });

    } catch (error) {
        console.error("Payment Error:", error.response ? error.response.data : error.message);
        res.status(500).json({
            success: false,
            message: error.response ? error.response.data.message : "Payment failed due to server error."
        });
    }
});

// सर्वर को चालू करने का कोड (Port 5000 पर)
// 🔒 P0 LOCKDOWN: loopback only — a bank-payout server has no business being
// reachable from the network. HOST=0.0.0.0 only by deliberate override.
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
    console.log(`🏦 Prasad ERP Cashfree Payment Server is LIVE on ${HOST}:${PORT}`);
});
