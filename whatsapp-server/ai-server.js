// @ts-nocheck
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');

// Firebase Setup
const serviceAccount = require("./serviceAccountKey.json"); 
// The ERP API replaces firebase-admin here — one writer for wa_chats, and the
// wa_msg_id dedupe that stops a reconnect from doubling the history.
const ERP_API = process.env.ERP_API_URL || 'http://127.0.0.1:3300';
const CRM_API = `${ERP_API}/api/v1/crm`;

const crmPost = async (path, body) => {
    const res = await fetch(`${CRM_API}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json().catch(() => ({}));
};
const crmGet = async (path) => {
    const res = await fetch(`${CRM_API}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
};
const app = express();
app.use(cors());
app.use(express.json());

// 🌟 MULTI-USER STORAGE
const waClients = {}; 
const qrCodes = {};   
const waStatus = {};  

// 🚀 Function to Start WhatsApp
const startWhatsAppForUser = (userId) => {
    if (waClients[userId]) return; 

    console.log(`⏳ Starting engine for User: ${userId}`);
    waStatus[userId] = 'STARTING';
    
    const client = new Client({ authStrategy: new LocalAuth({ clientId: `session-${userId}` }) });

    client.on('qr', (qr) => { 
        qrCodes[userId] = qr; 
        waStatus[userId] = 'QR_READY'; 
        console.log(`📲 QR Code ready for User: ${userId}`); 
    });
    
    client.on('ready', () => { 
        qrCodes[userId] = ''; 
        waStatus[userId] = 'CONNECTED'; 
        console.log(`✅ System READY for User: ${userId}`); 
    });
    
    client.on('disconnected', () => { 
        waStatus[userId] = 'DISCONNECTED'; 
        qrCodes[userId] = ''; 
        delete waClients[userId]; 
    });

    // 🌟 INCOMING MESSAGES (ममता AI + ड्राइवर/कस्टमर का रिप्लाई)
    client.on('message', async (msg) => {
        try {
            const senderPhone = msg.from.replace('@c.us', '').replace(/\D/g, '').slice(-10);
            
            // Save Incoming Chat to Firebase
            await crmPost('/chats', {
                userId: userId,
                phone: senderPhone,
                text: msg.body,
                type: 'incoming',
                timestamp: new Date().toISOString()
            });

            // Mamta AI Chatbot Logic
            const text = msg.body.toLowerCase();
            const { items: rules } = await crmGet('/rules');
            // A for..of, not forEach(async): forEach ignores the returned
            // promise, so every matching rule fired its reply and its log write
            // unawaited and unordered — and an error inside them escaped the
            // try/catch below entirely.
            for (const rule of rules ?? []) {
                if (!rule?.keyword) continue;
                if (!text.includes(String(rule.keyword).toLowerCase())) continue;
                await msg.reply(rule.reply);
                // Save AI Reply to the CRM too.
                await crmPost('/chats', {
                    userId: 'Mamta AI',
                    phone: senderPhone,
                    text: rule.reply,
                    type: 'outgoing',
                    timestamp: new Date().toISOString()
                });
                // First match wins; without this a message containing two
                // keywords got two replies.
                break;
            }
        } catch (error) { console.error("Chatbot Error:", error); }
    });

    client.initialize();
    waClients[userId] = client;
};

// 1. Get Status API
app.get('/api/status/:userId', (req, res) => {
    const { userId } = req.params;
    if (!waClients[userId]) { startWhatsAppForUser(userId); }
    res.json({ connected: waStatus[userId] === 'CONNECTED', qr: qrCodes[userId] || '', status: waStatus[userId] || 'WAITING' });
});

// 2. Send Message API (With Trip ID & Role Support)
app.post('/api/send-whatsapp', async (req, res) => {
    try {
        const { userId, number, message, tripId, role } = req.body;
        if (!waClients[userId] || waStatus[userId] !== 'CONNECTED') {
            return res.status(400).json({ success: false, message: "WhatsApp not connected!" });
        }
        
        const cleanNumber = number.replace(/\D/g, '').slice(-10);
        const formattedNumber = "91" + cleanNumber + "@c.us"; 
        
        await waClients[userId].sendMessage(formattedNumber, message);
        
        // Save Sent Chat to Firebase
        await crmPost('/chats', {
            userId: userId,
            phone: cleanNumber,
            text: message,
            type: 'outgoing',
            tripId: tripId || 'GENERAL',
            role: role || 'Contact',
            timestamp: new Date().toISOString()
        });

        res.json({ success: true, message: "Sent Successfully!" });
    } catch (error) { 
        res.status(500).json({ success: false, message: error.message }); 
    }
});

// 🔒 P0 LOCKDOWN: loopback only (legacy engine — NOTE it fights server.js for
// port 5001; run only one of the two).
app.listen(5001, '127.0.0.1', () => console.log("🤖 Master AI Engine LIVE on 127.0.0.1:5001"));