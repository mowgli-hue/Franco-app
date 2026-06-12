// Vercel serverless function — mints a short-lived HeyGen Streaming Avatar
// session token for the "Learn live with Sophie" video-call feature.
//
// Why this exists:
//   The HeyGen Interactive/Streaming Avatar SDK runs in the app (browser/WebView)
//   and needs a session token. That token is created with your HeyGen API KEY,
//   which must NEVER ship in the app bundle (anyone could extract it and spend
//   your credits). So the app calls THIS endpoint, and we create the token
//   server-side with the secret key.
//
// Setup (one time):
//   1. Vercel dashboard → franco-app → Settings → Environment Variables
//   2. Add: HEYGEN_API_KEY = <your HeyGen API key>   (HeyGen → Settings → API)
//   3. Redeploy.
//
// Client usage:
//   GET /api/heygen-token  →  200 { token: "..." }
//   (503 if the key isn't configured — the app then hides the live-call button.)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    console.error("[api/heygen-token] HEYGEN_API_KEY not set");
    return res.status(503).json({ error: "HeyGen not configured (HEYGEN_API_KEY missing)." });
  }

  try {
    const upstream = await fetch("https://api.heygen.com/v1/streaming.create_token", {
      method: "POST",
      headers: { "x-api-key": apiKey },
    });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      console.error("[api/heygen-token] HeyGen error:", upstream.status, errText);
      return res.status(upstream.status).json({ error: "HeyGen token request failed", status: upstream.status });
    }
    const data = await upstream.json();
    const token = data?.data?.token || data?.token;
    if (!token) return res.status(502).json({ error: "No token in HeyGen response" });
    // Tokens are short-lived and per-session — never cache.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ token });
  } catch (e) {
    console.error("[api/heygen-token] handler error:", e);
    return res.status(502).json({ error: e?.message || "HeyGen proxy error" });
  }
}
