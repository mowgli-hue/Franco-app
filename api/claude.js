// Vercel serverless function — proxies Claude API calls for the Franco app.
//
// Why we need this:
//   The Franco iOS app (and web) call this endpoint to talk to Claude.
//   We CANNOT call Anthropic directly from the client because:
//     1. The API key would be exposed in the JS bundle (security disaster)
//     2. Anthropic blocks browser/CORS requests for security
//
//   This serverless function keeps ANTHROPIC_API_KEY server-side as a Vercel
//   env var and proxies the request to Anthropic.
//
// Setup (one time):
//   1. Vercel dashboard → franco-app → Settings → Environment Variables
//   2. Add: ANTHROPIC_API_KEY = <your real key>
//   3. Redeploy
//
// Request format from client (POST):
//   {
//     "model": "claude-sonnet-4-20250514",
//     "max_tokens": 600,
//     "system": "You are Sophie, a French tutor...",
//     "messages": [{"role": "user", "content": "Bonjour!"}]
//   }
//
// Response format (Anthropic's standard):
//   { "content": [{"text": "..."}], ... }

export default async function handler(req, res) {
  // CORS — allow iOS Capacitor WebView + franco.app web to call this.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[api/claude] ANTHROPIC_API_KEY not set in Vercel env vars");
    return res.status(500).json({
      error: "Server misconfigured — Anthropic API key missing.",
      content: [{ text: "Désolé, le service IA n'est pas configuré. Contactez le support." }]
    });
  }

  try {
    const { model, max_tokens, system, messages } = req.body || {};

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Missing required field: messages (array)" });
    }

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-20250514",
        max_tokens: max_tokens || 600,
        system: system || "You are a helpful assistant.",
        messages,
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error("[api/claude] Anthropic returned error:", upstream.status, data);
      return res.status(upstream.status).json(data);
    }

    return res.status(200).json(data);
  } catch (e) {
    console.error("[api/claude] handler error:", e);
    return res.status(500).json({
      error: e?.message || "Internal server error",
      content: [{ text: "Désolé, une erreur s'est produite. Réessayez plus tard." }]
    });
  }
}
