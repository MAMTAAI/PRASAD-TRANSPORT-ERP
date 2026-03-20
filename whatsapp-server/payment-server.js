const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ⚠️ यहाँ आपकी Cashfree API Keys आएँगी (जब KYC अप्रूव हो जाएगी)
const CASHFREE_CLIENT_ID = 'YOUR_CASHFREE_CLIENT_ID';
const CASHFREE_CLIENT_SECRET = 'YOUR_CASHFREE_CLIENT_SECRET';

// 🌐 Production (Live) API URL for Cashfree Payouts
const BASE_URL = 'https://payout-api.cashfree.com/payout/v1';

// 🚀 API PAYOUT ROUTE (ERP से पैसा भेजने के लिए)
app.post('/api/payout', async (req, res) => {
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
const PORT = 5000;
app.listen(PORT, () => {
    console.log(`🏦 Prasad ERP Cashfree Payment Server is LIVE on Port ${PORT}`);
});