const functions = require("firebase-functions");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const textToSpeech = require("@google-cloud/text-to-speech");
const cors = require("cors")({ origin: true });

// ⚠️ DEPRECATED CLOUD PATH. The app is migrating to a 100% LOCAL voice
// assistant (local Gemma 4 + browser SpeechSynthesis, see src/lib/voice).
// This legacy function uses cloud Gemini + cloud TTS and is kept only for
// backward compatibility. NO secret is hardcoded — the key must come from the
// environment (GEMINI_API_KEY). If it's unset, the endpoint returns 503.
// 🔐 The previously hardcoded key has been REMOVED — rotate it in Google Cloud
//    Console (APIs & Services → Credentials) as it was exposed in git history.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const ttsClient = new textToSpeech.TextToSpeechClient();

// 2. हमने फंक्शन का नाम बदलकर 'mamtaVoice' कर दिया है ताकि पुराना एरर न आए
exports.mamtaVoice = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).send("Only POST requests are accepted");
    }

    try {
      const userPrompt = req.body.prompt;
      if (!userPrompt) {
        return res.status(400).send("Prompt is missing");
      }

      // 🔐 No hardcoded key anymore. If the env key is unset, the legacy cloud
      // path is disabled — the app should use the local voice engine instead.
      if (!GEMINI_API_KEY) {
        return res.status(503).json({
          error: "Mamta cloud voice is disabled. The app now uses a 100% local voice engine (local Gemma 4 + on-device TTS). Set GEMINI_API_KEY only if you still need this legacy cloud path.",
        });
      }

      // --- Gemini 1.5 Pro से जवाब लें ---
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-pro",
        systemInstruction: "आपका नाम Mamta AI है। आप PRASAD ERP सिस्टम की स्मार्ट असिस्टेंट हैं। हिंदी में हमेशा छोटे, सटीक और पेशेवर जवाब दें।"
      });

      const aiResult = await model.generateContent(userPrompt);
      const textResponse = await aiResult.response.text();

      // --- जवाब को ममता (Neural2-A) की आवाज़ में बदलें ---
      const request = {
        input: { text: textResponse },
        voice: {
          languageCode: "hi-IN",
          name: "hi-IN-Neural2-A", // ममता की आवाज़
          ssmlGender: "FEMALE",
        },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: 1.0,
          pitch: 1.0,
        },
      };

      const [ttsResponse] = await ttsClient.synthesizeSpeech(request);
      const audioBase64 = ttsResponse.audioContent.toString("base64");

      // Frontend को डेटा वापस भेजें
      res.status(200).json({
        text: textResponse,
        audioContent: audioBase64,
      });

    } catch (error) {
      console.error("Mamta AI Backend Error:", error);
      res.status(500).json({ error: "ममता AI से कनेक्ट करने में कोई समस्या आ रही है।" });
    }
  });
});
// ═════════════════════════════════════════════════════════════════════════
// 🛡️ generateAutoBill — SERVER-SIDE TRANSACTION GUARD for monthly billing.
// Eliminates the simultaneous double-billing race 100%: inside ONE Firestore
// transaction it (re)reads every trip and aborts if ANY trip is missing,
// belongs to a different operating company, or is already BILLED. Only when
// every check passes are the invoice doc + all trip flips written — atomically.
// Two machines saving the same trips at the same second: exactly one wins,
// the other gets a clean "already billed" error.
// ═════════════════════════════════════════════════════════════════════════
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();

exports.generateAutoBill = onCall({ region: "us-central1" }, async (request) => {
  // ── Staff-only: signed in with email/password + active USERS profile ──
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Login required.");
  const provider = auth.token?.firebase?.sign_in_provider;
  if (provider !== "password") throw new HttpsError("permission-denied", "Staff login (email/password) required.");
  const db = admin.firestore();
  const userSnap = await db.collection("USERS").doc(auth.uid).get();
  if (!userSnap.exists || userSnap.data().status === "INACTIVE") {
    throw new HttpsError("permission-denied", "Staff profile not found or inactive.");
  }

  // ── Input validation ──
  const { company, customer, invoice, trips } = request.data || {};
  if (!company || typeof company !== "string") throw new HttpsError("invalid-argument", "operating company missing");
  if (!customer || typeof customer !== "string") throw new HttpsError("invalid-argument", "customer missing");
  if (!invoice || typeof invoice !== "object") throw new HttpsError("invalid-argument", "invoice payload missing");
  if (!Array.isArray(trips) || !trips.length) throw new HttpsError("invalid-argument", "trip list empty");
  if (trips.length > 400) throw new HttpsError("invalid-argument", "too many trips for one bill (max 400)");
  for (const t of trips) {
    if (!t || typeof t.id !== "string" || !t.id) throw new HttpsError("invalid-argument", "trip id missing");
    if (typeof t.gross_freight !== "number" || !isFinite(t.gross_freight)) throw new HttpsError("invalid-argument", `bad freight for trip ${t.id}`);
  }

  const tripCompanyOf = (d) => String(d.operating_company || d.Operating_Company || d.company || "").trim();

  // ── THE TRANSACTION: read-verify-write atomically ──
  const invoiceRef = db.collection("MONTHLY_INVOICES").doc();
  await db.runTransaction(async (tx) => {
    // 1. READ all trips first (admin transactions require reads before writes).
    const refs = trips.map((t) => db.collection("TRIPS").doc(t.id));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));

    // 2. VERIFY — any failure aborts the WHOLE transaction (nothing written).
    const missing = [], wrongCompany = [], alreadyBilled = [];
    snaps.forEach((s, i) => {
      const cn = trips[i].cn || trips[i].id;
      if (!s.exists) { missing.push(cn); return; }
      const d = s.data();
      const tc = tripCompanyOf(d);
      if (tc && tc.toUpperCase() !== company.toUpperCase()) wrongCompany.push(`${cn} (${tc})`);
      if ((d.billing_status || "") === "BILLED") alreadyBilled.push(cn);
    });
    if (missing.length) throw new HttpsError("failed-precondition", `Trips not found in DB: ${missing.join(", ")}`);
    if (wrongCompany.length) throw new HttpsError("failed-precondition", `COMPANY MISMATCH — ye trips ${company} ki nahi hain: ${wrongCompany.join(", ")}`);
    if (alreadyBilled.length) throw new HttpsError("already-exists", `DOUBLE-BILLING BLOCKED — pehle se BILLED: ${alreadyBilled.join(", ")}. (Kisi aur ne abhi bill bana diya?)`);

    // 3. WRITE — invoice + every trip flip, all-or-nothing.
    tx.set(invoiceRef, {
      ...invoice,
      customer, company,
      trip_ids: trips.map((t) => t.id),
      created_by_uid: auth.uid,
      guard: "cloud_transaction",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const billedAt = new Date().toISOString();
    snaps.forEach((s, i) => {
      tx.update(s.ref, {
        gross_freight: trips[i].gross_freight,
        rate: trips[i].rate ?? null,
        billing_status: "BILLED",
        billed_bill_no: invoice.invoice_no || "",
        billed_at: billedAt,
        billed_company: company,
      });
    });
  });

  return { ok: true, invoice_id: invoiceRef.id, trips_billed: trips.length };
});
