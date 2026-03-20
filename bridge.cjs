require('dotenv').config(); // ✅ Environment variables के लिए (Render/Local दोनों जगह काम करेगा)
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios'); // 🎤 नया: ममता AI की आवाज़ के लिए जोड़ा गया

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// --- 1. GOOGLE DRIVE SETUP ---
const KEYFILEPATH = './google-key.json';
const SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.send'];
const auth = new google.auth.GoogleAuth({ keyFile: KEYFILEPATH, scopes: SCOPES });

// --- 2. MAMTA AI (GEMINI) SETUP ---
// (API Key .env फाइल या Render Environment से आनी चाहिए)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 🔑 आपकी Google Cloud TTS API Key (ममता AI की असली आवाज़ के लिए)
const GOOGLE_TTS_API_KEY = '***REMOVED-ROTATE-ME***';

// =======================================================
// ROUTE 1: UPLOAD & EXTRACT DATA (DRIVE + AI)
// =======================================================
app.post('/upload-to-drive', upload.single('file'), async (req, res) => {
  // ✅ Check if file exists
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded!" });
  }

  try {
    const driveService = google.drive({ version: 'v3', auth });

    // --- PART A: GOOGLE DRIVE SMART UPLOAD ---
    const driverName = req.body.driverName || "Unknown_Driver"; 
    const MAIN_FOLDER_ID = '1wxmHB_494sxqMKus7JKv8B83i67mEXer';

    let driverFolderId = null;
    
    // 1. Check if folder exists
    const folderSearch = await driveService.files.list({
      q: `name='${driverName}' and '${MAIN_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    if (folderSearch.data.files && folderSearch.data.files.length > 0) {
      driverFolderId = folderSearch.data.files[0].id;
    } else {
      // 2. Create new folder if not exists
      const folderMetaData = {
        name: driverName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [MAIN_FOLDER_ID]
      };
      const folderResponse = await driveService.files.create({
        resource: folderMetaData,
        fields: 'id',
        supportsAllDrives: true
      });
      driverFolderId = folderResponse.data.id;
    }

    // 3. Format Date & Time for File Name
    const date = new Date();
    const formattedDate = date.toLocaleDateString('en-GB').replace(/\//g, '-'); 
    const formattedTime = date.toLocaleTimeString('en-GB').replace(/:/g, '-'); 
    const systemFileName = `${driverName}_${formattedDate}_${formattedTime}_${req.file.originalname}`;

    // 4. Upload File to Drive
    const fileMetaData = { name: systemFileName, parents: [driverFolderId] };
    const media = { mimeType: req.file.mimetype, body: fs.createReadStream(req.file.path) };

    const driveResponse = await driveService.files.create({
      resource: fileMetaData,
      media: media,
      fields: 'id, webViewLink',
      supportsAllDrives: true
    });

    // 5. Make the file visible to anyone with the link
    await driveService.permissions.create({
      fileId: driveResponse.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true
    });

    const driveLink = driveResponse.data.webViewLink;

    // --- PART B: MAMTA AI DATA EXTRACTION ---
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    function fileToGenerativePart(filePath, mimeType) {
        return {
            inlineData: {
                data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
                mimeType
            },
        };
    }
    const imageParts = [fileToGenerativePart(req.file.path, req.file.mimetype)];

    const prompt = `
    You are an expert Logistics & Transport Document Analyzer for Prasad Transport ERP.
    Analyze the uploaded image/document and automatically detect its type (e.g., IOCL Invoice, Loading/Unloading Slip, HSD Petrol Pump Bill, Driving License, Vehicle RC, Toll Receipt, etc.).
    Extract all relevant details accurately. Even if the text is slightly faded or in a table, read it carefully. 
    Return the output STRICTLY as a JSON object without any markdown, formatting, or extra text.

    If a field is not present in the document, leave its value as an empty string "".

    Use this exact JSON structure:
    {
      "documentType": "Detect and write type",
      "documentNumber": "Invoice No, Bill No, DL No, or Challan No",
      "documentDate": "Date of the document",
      "vehicleNumber": "Vehicle/Truck Registration Number",
      "partyName": "Name of the Petrol Pump, Client, or Person",
      "fromLocation": "Loading point or Source",
      "toLocation": "Unloading point or Destination",
      "quantity": "Quantity",
      "totalAmount": "Total bill amount or Invoice value",
      "driverName": "Name of the driver",
      "extraDetails": "Any other important detail"
    }
    `;

    const aiResult = await model.generateContent([prompt, ...imageParts]);
    const responseText = aiResult.response.text();
    
    // ✅ Clean AI JSON output safely
    const cleanedText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
    let extractedData = {};
    try {
        extractedData = JSON.parse(cleanedText);
    } catch (parseError) {
        console.error("JSON Parse Error. Raw AI Output:", cleanedText);
        extractedData = { error: "AI could not format data properly", rawText: cleanedText };
    }

    // --- PART C: SEND FINAL RESULT TO WEBSITE ---
    res.status(200).json({
      success: true,
      driveLink: driveLink,
      aiData: extractedData
    });

  } catch (error) {
    console.error("❌ ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    // ✅ SAFE CLEANUP
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

// =======================================================
// ROUTE 2: AUTO EMAIL SENDING TEST
// =======================================================
app.get('/test-email', async (req, res) => {
  try {
    const keys = require('./google-key.json');
    
    // 🤖 Robot is taking permission to use info@prasadtransport.com
    const jwtClient = new google.auth.JWT(
      keys.client_email,
      null,
      keys.private_key,
      ['https://www.googleapis.com/auth/gmail.send'],
      'info@prasadtransport.com' // Subject: The Alias email we created
    );

    // Explicitly authorize the client
    await jwtClient.authorize();

    const gmail = google.gmail({ version: 'v1', auth: jwtClient });

    const toEmail = 'jaiswalcapital1@gmail.com'; 
    const subject = '🎉 Prasad Transport ERP - Live Test Successful!';
    const message = 'Hello Subhash Sir,\n\nCongratulations! This is an automatic test email sent directly from your ERP System using the new info@prasadtransport.com ID. Your robot is working perfectly!\n\nRegards,\nERP Robot 🤖';

    // Format email exactly as Gmail API expects
    const rawMessage = [
      `To: ${toEmail}`,
      'Subject: ' + subject,
      '',
      message
    ].join('\n');

    // Base64URL encode the message
    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Send Email
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage }
    });

    res.status(200).send(`
      <div style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h1 style="color: #10b981;">✅ SUCCESS!</h1>
        <h2>Test Email has been sent successfully!</h2>
        <p>Please check the inbox of <b>jaiswalcapital1@gmail.com</b>.</p>
        <p style="color: #64748b; font-size: 14px; margin-top: 20px;">Sent via: info@prasadtransport.com</p>
      </div>
    `);

  } catch (error) {
    console.error("❌ EMAIL ERROR:", error);
    res.status(500).send(`
      <div style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h1 style="color: #ef4444;">❌ ERROR</h1>
        <p style="background: #fee2e2; padding: 15px; border-radius: 8px; color: #b91c1c; display: inline-block;">
          ${error.message}
        </p>
        <p>Please check your Google Workspace Admin settings for Domain-Wide Delegation.</p>
      </div>
    `);
  }
});

// =======================================================
// ROUTE 3: MAMTA AI PREMIUM VOICE (Google TTS - Madhuri Style)
// =======================================================
app.post('/speak', async (req, res) => {
    try {
        const { text } = req.body;
        
        // Google TTS API को रिक्वेस्ट भेज रहे हैं
        const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`;

        const requestBody = {
            input: { text: text },
            voice: { 
                languageCode: 'hi-IN', 
                name: 'hi-IN-Neural2-A', // 🎤 माधुरी जैसी प्रीमियम Neural आवाज़
                ssmlGender: 'FEMALE' 
            },
            audioConfig: { 
                audioEncoding: 'MP3',
                pitch: 1.2, 
                speakingRate: 0.95 
            }
        };

        const response = await axios.post(url, requestBody);
        res.json({ success: true, audioContent: response.data.audioContent });

    } catch (error) {
        console.error("TTS API Error:", error.message);
        res.status(500).json({ success: false, message: "Voice generation failed." });
    }
});

// --- 4. START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PRASAD ERP BRIDGE IS LIVE ON PORT ${PORT}`);
});