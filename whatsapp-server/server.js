// @ts-nocheck
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mongoose = require('mongoose');

// 🔥 Naya Package: File Upload aur AI ke liye
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

// 🗄️ Database Connection
const mongoURI = "mongodb://Mamta123:Bihar%405217@ac-ww17p1s-shard-00-00.wiygiox.mongodb.net:27017,ac-ww17p1s-shard-00-01.wiygiox.mongodb.net:27017,ac-ww17p1s-shard-00-02.wiygiox.mongodb.net:27017/?ssl=true&replicaSet=atlas-xtbebi-shard-0&authSource=admin&appName=Cluster0";

mongoose.connect(mongoURI)
    .then(() => console.log('🗄️ Database Connected Successfully!'))
    .catch(err => console.log('❌ Database Error:', err));

// 🧠 Smart Models 
const Rule = mongoose.model('Rule', new mongoose.Schema({ keyword: String, reply: String }));
const Contact = mongoose.model('Contact', new mongoose.Schema({ 
    name: String, phone: String, category: String, company: String, truckNo: String, gst: String, details: String 
}));
const Draft = mongoose.model('Draft', new mongoose.Schema({ title: String, content: String }));
const Task = mongoose.model('Task', new mongoose.Schema({ title: String, description: String, status: { type: String, default: 'LEAD' }, phone: String }));
const Signature = mongoose.model('Signature', new mongoose.Schema({ title: String, content: String }));

let currentQR = ''; 
let isConnected = false;

// 📲 WhatsApp Engine Setup
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions'] }
});

client.on('qr', (qr) => { 
    currentQR = qr; 
    isConnected = false; 
    console.log("📲 New QR Code Generated! Scan it from the Frontend.");
});

client.on('ready', () => { 
    isConnected = true; 
    currentQR = ''; 
    console.log("✅ WhatsApp Online & Ready! Mamta AI is active."); 
});

client.on('disconnected', (reason) => { 
    isConnected = false; 
    currentQR = ''; 
    console.log("❌ WhatsApp Disconnected! Reason:", reason);
    setTimeout(() => { client.initialize(); }, 3000);
});

// 🤖 Mamta AI Auto-Reply Logic (WhatsApp)
client.on('message', async (msg) => {
    try {
        const text = msg.body.toLowerCase().trim();
        const rule = await Rule.findOne({ keyword: text });
        
        if (rule) {
            await msg.reply(rule.reply);
        } else if (text === 'hi' || text === 'hello') {
            await msg.reply('नमस्कार! प्रसाद ट्रांसपोर्ट ERP में आपका स्वागत है। मैं Mamta AI हूँ। आपकी क्या सहायता करूँ? 🙏');
        }
    } catch (err) {
        console.error("Auto-reply Error:", err);
    }
});

client.initialize();

// ==========================================
// 🌐 API Routes (Website को जोड़ने के लिए)
// ==========================================

app.get('/api/status', (req, res) => {
    res.json({ connected: isConnected, qr: currentQR });
});

app.post('/api/logout', async (req, res) => {
    try {
        await client.logout();
        isConnected = false; 
        currentQR = '';
        res.json({ success: true, message: "Logged out successfully" });
        setTimeout(() => { client.initialize(); }, 3000);
    } catch (e) { 
        res.status(500).json({ success: false, message: "Failed to logout" }); 
    }
});

app.post('/api/send-message', async (req, res) => {
    let { phone, message } = req.body;
    try {
        let formattedPhone = phone.replace(/\D/g, ''); 
        if (formattedPhone.length === 10) formattedPhone = `91${formattedPhone}`;
        const chatId = formattedPhone.includes('@c.us') ? formattedPhone : `${formattedPhone}@c.us`;
        await client.sendMessage(chatId, message);
        res.json({ success: true });
    } catch (e) { 
        res.status(500).json({ success: false, message: e.message }); 
    }
});

const setupRoutes = (path, Model) => {
    app.get(`/api/${path}`, async (req, res) => {
        try {
            const data = await Model.find().sort({ _id: -1 });
            res.json({ success: true, data });
        } catch(e) { res.status(500).json({success: false}); }
    });
    app.post(`/api/${path}`, async (req, res) => {
        try {
            const item = new Model(req.body);
            await item.save();
            res.json({ success: true, item });
        } catch(e) { res.status(500).json({success: false}); }
    });
    app.delete(`/api/${path}/:id`, async (req, res) => {
        try {
            await Model.findByIdAndDelete(req.params.id);
            res.json({ success: true });
        } catch(e) { res.status(500).json({success: false}); }
    });
};

setupRoutes('contacts', Contact); 
setupRoutes('rules', Rule); 
setupRoutes('drafts', Draft); 
setupRoutes('tasks', Task); 
setupRoutes('signatures', Signature);

app.post('/api/update-task', async (req, res) => {
    try {
        await Task.findByIdAndUpdate(req.body.id, { status: req.body.status });
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ success: false });
    }
});

// ==========================================
// 🚀 NEW: MAMTA AI DOCUMENT SCANNER ENGINE
// ==========================================

// फाइल अपलोड सेटिंग (मेमोरी में रखने के लिए)
const upload = multer({ storage: multer.memoryStorage() });

// 🔴 यहाँ अपनी असली Gemini API Key डालें
const genAI = new GoogleGenerativeAI("***REMOVED-ROTATE-ME***API_KEY_HERE"); 

app.post('/upload-to-drive', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No file provided!" });
        }

        console.log(`📂 Document received: ${req.file.originalname}`);

        // 1. Google Drive Upload (अभी डमी लिंक है, बाद में असली ड्राइव लॉजिक लगा सकते हैं)
        const driveLink = "https://drive.google.com/file/d/temp-link/view";

        // 2. Mamta AI Scanning Process
        console.log("🤖 Mamta AI (Gemini) is analyzing the document...");
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `
        You are Mamta AI, an expert transport document analyzer. 
        Read this vehicle document and extract the following details in strictly valid JSON format. 
        Do not add any text, explanations, or markdown blocks (like \`\`\`json) outside the JSON object.
        JSON Format required:
        {
            "documentNumber": "extract Document/Application/Policy/Certificate/Receipt No (remove any starting colons)",
            "documentDate": "extract Issue Date or Valid From date (format DD-MM-YYYY)",
            "expiryDate": "extract Valid Upto or Expiry Date (format DD-MM-YYYY)",
            "totalAmount": "extract Total Fees or Amount Paid (only digits)"
        }`;

        const imagePart = {
            inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: req.file.mimetype
            }
        };

        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        let aiText = response.text();

        // 🧹 Clean JSON string before parsing
        aiText = aiText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const aiData = JSON.parse(aiText);

        console.log("✅ Extracted Data:", aiData);

        // Send Success Response to Frontend
        res.json({ 
            success: true, 
            driveLink: driveLink, 
            aiData: aiData 
        });

    } catch (error) {
        console.error("❌ Mamta AI Scan Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// 🚀 Start Server
const PORT = process.env.PORT || 5001; // Render के लिए process.env.PORT ज़रूरी है
app.listen(PORT, () => {
    console.log(`🚀 Mamta AI Engine is running perfectly on Port ${PORT}`);
});