// Vercel serverless function — proxies ElevenLabs text-to-speech for the Franco app.
//
// Why we need this:
//   Franco's lessons play French audio (listen questions, "Listen" buttons,
//   the speaking coach's model answer). The device's built-in TTS often has no
//   real French-Canadian voice installed, so it reads French with an English
//   voice. This endpoint returns natural French audio from ElevenLabs instead.
//
//   Like api/claude.js, the API key stays SERVER-SIDE — it must never be in the
//   app bundle (anyone could extract it).
//
// Setup (one time):
//   1. Vercel dashboard → franco-app → Settings → Environment Variables
//   2. Add: ELEVENLABS_API_KEY = <your real ElevenLabs key>
//   3. (optional) Add: ELEVENLABS_VOICE_ID = <a voice id from your account /
//      the ElevenLabs Voice Library>. If omitted we use the default below.
//      To get a Canadian-French voice: ElevenLabs → Voice Library → filter by
//      French → "Add to my voices" → copy its Voice ID into ELEVENLABS_VOICE_ID.
//   4. Redeploy.
//
// Cost note:
//   Responses are cached hard at Vercel's CDN (Cache-Control below). Because the
//   lesson text is fixed, each unique line is synthesised by ElevenLabs only
//   ONCE — every subsequent request (any user, any device) is served from cache.
//   This keeps character usage low even with many users.
//
// Client usage (GET, so the CDN can cache it):
//   GET /api/tts?text=Bonjour%20le%20Canada&v=<optional voice id override>
//   → 200 audio/mpeg  (an MP3 stream)

const DEFAULT_VOICE_ID = "XTyroWkQl32ZSd3rRVZ1"; // Canadian-French voice chosen by the owner. Override anytime via ELEVENLABS_VOICE_ID.
const MODEL_ID = "eleven_multilingual_v2";       // auto-detects French from the text
const MAX_CHARS = 600;                            // safety cap per request

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Accept text from query (GET — cacheable) or body (POST — for long text).
  const q = req.query || {};
  const body = req.body || {};
  let text = (req.method === "POST" ? body.text : q.text) || "";
  const voiceId = (req.method === "POST" ? body.v : q.v) || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;

  text = String(text).trim().slice(0, MAX_CHARS);
  if (!text) return res.status(400).json({ error: "Missing required parameter: text" });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error("[api/tts] ELEVENLABS_API_KEY not set");
    // 503 signals the client to fall back to on-device TTS.
    return res.status(503).json({ error: "TTS not configured (ELEVENLABS_API_KEY missing)." });
  }

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "content-type": "application/json",
          "accept": "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true },
        }),
      }
    );

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      console.error("[api/tts] ElevenLabs error:", upstream.status, errText);
      // 5xx/4xx → client falls back to device TTS.
      return res.status(upstream.status === 401 ? 503 : upstream.status).json({
        error: "ElevenLabs request failed", status: upstream.status,
      });
    }

    const arrayBuf = await upstream.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    // Generate-once: cache hard at the CDN. Identical text+voice served from cache for everyone.
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=31536000, immutable");
    return res.status(200).send(Buffer.from(arrayBuf));
  } catch (e) {
    console.error("[api/tts] handler error:", e);
    return res.status(502).json({ error: e?.message || "TTS proxy error" });
  }
}
