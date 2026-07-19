// @ts-nocheck
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const stream = require('stream');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 🗄️ DATABASE CONNECTION
// ==========================================
const mongoURI = "mongodb://Mamta123:Bihar%405217@ac-ww17p1s-shard-00-00.wiygiox.mongodb.net:27017,ac-ww17p1s-shard-00-01.wiygiox.mongodb.net:27017,ac-ww17p1s-shard-00-02.wiygiox.mongodb.net:27017/?ssl=true&replicaSet=atlas-xtbebi-shard-0&authSource=admin&appName=Cluster0";

mongoose.connect(mongoURI)
    .then(() => console.log('🗄️ Database Connected Successfully!'))
    .catch(err => console.log('❌ Database Error:', err));

const Rule = mongoose.model('Rule', new mongoose.Schema({ keyword: String, reply: String }));
const Contact = mongoose.model('Contact', new mongoose.Schema({ 
    name: String, phone: String, category: String, company: String, truckNo: String, gst: String, details: String 
}));
const Draft = mongoose.model('Draft', new mongoose.Schema({ title: String, content: String }));
const Task = mongoose.model('Task', new mongoose.Schema({ title: String, description: String, status: { type: String, default: 'LEAD' }, phone: String }));
const Signature = mongoose.model('Signature', new mongoose.Schema({ title: String, content: String }));

let currentQR = ''; 
let isConnected = false;

// ==========================================
// 📲 WHATSAPP ENGINE SETUP
// ==========================================
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
// 🌐 API ROUTES (Whatsapp & DB)
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


// ==============================================================
// 🚀 MAMTA AI DOCUMENT SCANNER + 📂 GOOGLE DRIVE AUTO-FOLDER SYNC
// ==============================================================

const upload = multer({ storage: multer.memoryStorage() });

// 🔴 AI Key — set GEMINI_API_KEY in the environment before starting (never commit keys)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// 🔴 GOOGLE DRIVE SETUP
const KEYFILEPATH = './google-key.json'; 
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'];

const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: SCOPES,
});
const drive = google.drive({ version: 'v3', auth });

const MAIN_UPLOADS_FOLDER_ID = '1wxmHB_494sxqMKus7JKv8B83i67mEXer'; 

// 🌟 SMART PERMISSION HELPER (Forces the file to be 100% public)
async function makeFilePublic(fileId) {
    try {
        await drive.permissions.create({
            fileId: fileId,
            requestBody: {
                role: 'reader',
                type: 'anyone', // Anyone on the internet can view
                allowFileDiscovery: false
            }
        });
        console.log(`🔓 Successfully forced Public Access for File ID: ${fileId}`);
    } catch (err) {
        console.error(`⚠️ Warning: Could not set public permissions for ${fileId}:`, err.message);
    }
}

app.post('/upload-to-drive', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No file provided!" });
        }

        console.log(`📂 Processing Document: ${req.file.originalname}`);

        const vehicleNo = req.body.driverName ? req.body.driverName.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : 'UNKNOWN_VEHICLE';
        const docType = req.body.docType ? req.body.docType.replace(/[^A-Za-z0-9]/g, '_') : 'Document';
        
        let vehicleFolderId = null;

        const folderQuery = `mimeType='application/vnd.google-apps.folder' and name='${vehicleNo}' and '${MAIN_UPLOADS_FOLDER_ID}' in parents and trashed=false`;
        
        const folderSearch = await drive.files.list({
            q: folderQuery,
            fields: 'files(id, name)',
        });

        if (folderSearch.data.files.length > 0) {
            vehicleFolderId = folderSearch.data.files[0].id;
        } else {
            console.log(`📁 Creating NEW folder for ${vehicleNo}`);
            const folderMetadata = {
                name: vehicleNo,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [MAIN_UPLOADS_FOLDER_ID]
            };
            const folder = await drive.files.create({
                resource: folderMetadata,
                fields: 'id'
            });
            vehicleFolderId = folder.data.id;
            // Force folder to be public too
            await makeFilePublic(vehicleFolderId);
        }

        const fileExtension = req.file.originalname.split('.').pop() || 'pdf';
        const cleanFileName = `${docType}_${vehicleNo}_${Date.now()}.${fileExtension}`;

        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);

        const fileMetadata = {
            name: cleanFileName,
            parents: [vehicleFolderId] 
        };

        const media = {
            mimeType: req.file.mimetype,
            body: bufferStream,
        };

        console.log(`☁️ Uploading to Google Drive as ${cleanFileName}...`);
        const uploadedFile = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink, webContentLink'
        });

        // 🚀 FORCE PUBLIC ACCESS ON THE UPLOADED FILE
        await makeFilePublic(uploadedFile.data.id);

        const actualDriveLink = uploadedFile.data.webViewLink;
        console.log(`✅ File Uploaded & Publicly Available: ${actualDriveLink}`);


        console.log("🤖 Mamta AI is extracting text and data...");
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `
        You are Mamta AI, an expert transport document analyzer. 
        Read this vehicle document and extract the following details in strictly valid JSON format. 
        Do not add any text, explanations, or markdown blocks (like \`\`\`json) outside the JSON object.
        JSON Format required:
        {
            "documentNumber": "extract Document/Application/Policy/Certificate/Receipt No (remove any starting colons)",
            "documentDate": "extract Issue Date or Valid From date (format YYYY-MM-DD or DD-MM-YYYY)",
            "expiryDate": "extract Valid Upto or Expiry Date (format YYYY-MM-DD or DD-MM-YYYY)",
            "totalAmount": "extract Total Fees or Amount Paid (only digits)"
        }`;

        const imagePart = {
            inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: req.file.mimetype
            }
        };

        let aiData = null;
        try {
            const result = await model.generateContent([prompt, imagePart]);
            const response = await result.response;
            let aiText = response.text();

            aiText = aiText.replace(/```json/gi, '').replace(/```/g, '').trim();
            aiData = JSON.parse(aiText);
            console.log("✅ AI Extracted Data:", aiData);
        } catch (aiErr) {
            console.log("⚠️ AI Scanning failed or returned invalid format. Returning Drive Link only.", aiErr.message);
        }

        res.json({ 
            success: true, 
            driveLink: actualDriveLink, 
            fileId: uploadedFile.data.id,
            aiData: aiData || {} 
        });

    } catch (error) {
        console.error("❌ Fatal Upload/Scan Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 🚀 Start Server
const PORT = process.env.PORT || 5001; 
app.listen(PORT, () => {
    console.log(`🚀 Mamta AI Engine is running perfectly on Port ${PORT}`);
});