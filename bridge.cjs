const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');

const app = express();
app.use(cors());
const upload = multer({ storage: multer.memoryStorage() });

const KEYFILEPATH = './google-key.json';
const GOOGLE_DRIVE_FOLDER_ID = '1UUXvasyH6jGadqwwQvkSwJblRE2k-_7V';

const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
});

app.post('/upload-to-drive', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'फाइल नहीं मिली!' });

        const driveService = google.drive({ version: 'v3', auth });
        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);

        const response = await driveService.files.create({
            requestBody: { name: req.file.originalname, parents: [GOOGLE_DRIVE_FOLDER_ID] },
            media: { mimeType: req.file.mimetype, body: bufferStream },
            fields: 'id, webViewLink',
        });

        console.log('✅ अपलोड सफल! Drive ID:', response.data.id);
        res.status(200).json({ success: true, link: response.data.webViewLink });

    } catch (error) {
        console.error('❌ गड़बड़ हुई:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(5000, () => {
    console.log(`🚀 PRASAD ERP BRIDGE IS LIVE ON PORT 5000`);
});