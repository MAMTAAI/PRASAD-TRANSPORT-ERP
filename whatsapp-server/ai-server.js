// @ts-nocheck
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { Client, LocalAuth } = require('whatsapp-web.js');

// Firebase Setup
const serviceAccount = require("./serviceAccountKey.json"); 
if (!admin.apps.length) { 
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }); 
}
const db = admin.firestore();
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
            await db.collection('WA_CHATS').add({
                userId: userId,
                phone: senderPhone,
                text: msg.body,
                type: 'incoming',
                timestamp: new Date().toISOString()
            });

            // Mamta AI Chatbot Logic
            const text = msg.body.toLowerCase();
            const rulesSnapshot = await db.collection('WA_RULES').get();
            rulesSnapshot.forEach(async doc => {
                const rule = doc.data();
                if (text.includes(rule.keyword.toLowerCase())) { 
                    msg.reply(rule.reply); 
                    // Save AI Reply to Database too!
                    await db.collection('WA_CHATS').add({
                        userId: 'Mamta AI',
                        phone: senderPhone,
                        text: rule.reply,
                        type: 'outgoing',
                        timestamp: new Date().toISOString()
                    });
                }
            });
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
        await db.collection('WA_CHATS').add({
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

app.listen(5001, () => console.log("🤖 Master AI Engine LIVE on port 5001"));