// Vercel serverless function — mints a HeyGen **LiveAvatar** session token for the
// live "Talk to Sophie" video call. (HeyGen retired the old Interactive-Avatar
// streaming API on 2026-03-31; LiveAvatar is the replacement.)
//
// We use FULL mode: HeyGen runs ASR + LLM + TTS, so the avatar holds the whole
// conversation. Sophie's teaching personality lives in a LiveAvatar "Knowledge
// Base" (context_id) you create in the LiveAvatar dashboard.
//
// Setup (Vercel → Settings → Environment Variables → Redeploy):
//   HEYGEN_API_KEY            your LiveAvatar/HeyGen API key  (required)
//   LIVEAVATAR_AVATAR_ID      your Sophie avatar id           (defaults to sandbox test avatar)
//   LIVEAVATAR_CONTEXT_ID     your knowledge-base/context id  (defaults to sandbox)
//   LIVEAVATAR_VOICE_ID       voice id for the avatar         (optional)
//   LIVEAVATAR_LANGUAGE       e.g. "fr" or "en"               (default "en")
//   LIVEAVATAR_SANDBOX        "true" = no credits (testing).  Set "false" to go live.
//
// Returns: { token: "<session_token>", sessionId: "<uuid>" }   (503 if no key)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "LiveAvatar not configured (HEYGEN_API_KEY missing)." });

  // Defaults = HeyGen's documented sandbox test avatar (free, English) so the
  // pipeline can be verified before a real Sophie avatar exists.
  const avatarId  = process.env.LIVEAVATAR_AVATAR_ID  || "65f9e3c9-d48b-4118-b73a-4ae2e3cbb8f0";
  const contextId = process.env.LIVEAVATAR_CONTEXT_ID || "158f5d55-2d4f-11f1-8d28-066a7fa2e369";
  const voiceId   = process.env.LIVEAVATAR_VOICE_ID   || undefined;
  const language  = process.env.LIVEAVATAR_LANGUAGE   || "en";
  const sandbox   = process.env.LIVEAVATAR_SANDBOX !== "false"; // default ON until you go live

  const persona = { context_id: contextId, language };
  if (voiceId) persona.voice_id = voiceId;

  try {
    const upstream = await fetch("https://api.liveavatar.com/v1/sessions/token", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "FULL",
        avatar_id: avatarId,
        is_sandbox: sandbox,
        interactivity_type: "CONVERSATIONAL",
        avatar_persona: persona,
      }),
    });
    const data = await upstream.json().catch(() => ({}));
    const token = data?.data?.session_token;
    if (!token) {
      console.error("[api/heygen-token] LiveAvatar token error:", upstream.status, JSON.stringify(data));
      return res.status(upstream.status || 502).json({ error: "No session token from LiveAvatar", detail: data });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ token, sessionId: data?.data?.session_id });
  } catch (e) {
    console.error("[api/heygen-token] handler error:", e);
    return res.status(502).json({ error: e?.message || "LiveAvatar proxy error" });
  }
}
