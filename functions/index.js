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