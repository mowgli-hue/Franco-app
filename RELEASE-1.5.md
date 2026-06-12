# Franco 1.5 — Release Checklist

Everything needed to ship 1.5. Run all commands **in the Franco folder**:
`cd "/Users/junglelabs/Documents/New project/franco-app"`
(Not `nimmi` — that's a different project.)

---

## What's in 1.5
- Speaking recording no longer freezes; now uses **real native speech recognition** to check pronunciation
- **Mid-lesson progress saves** — leaving/going back resumes where you left off, score intact
- **Word Rush mini-game** in Foundation lessons
- **Sound buttons** on match questions (hear each French word)
- **"Claude"/AI vendor naming removed** from lesson screens (now Sophie-branded)
- **In-app "update available" banner** (compares to the App Store version)
- **Capgo OTA plugin** + **daily reminder notifications** built in
- **HeyGen "video call with Sophie"** (ships dark — `HEYGEN_ENABLED` flag)

---

## 1. Install native plugins (one-time)
```
npm i @capacitor-community/speech-recognition
```
(The Capgo updater + local-notifications plugins are already installed.)

## 2. Build + sync
```
npm run build
npx cap sync ios
```
> Always run `npm run build` BEFORE `npx cap sync ios`, or the app ships stale code.

## 3. Deploy the web/API side (Vercel)
```
git add -A
git commit -m "1.5 release"
git push
```
This deploys the serverless functions (`api/heygen-token.js`, `api/tts.js`, `api/claude.js`).

### Vercel environment variables to confirm are set
- `ELEVENLABS_API_KEY` — French voice TTS
- `HEYGEN_API_KEY` — only needed if turning on the live video call

## 4. iOS app (Xcode)
`npx cap open ios`

1. **Info.plist** — add these two keys (Speech + Mic permission):
   - `NSSpeechRecognitionUsageDescription`
     → "Franco uses speech recognition to check your French pronunciation."
   - `NSMicrophoneUsageDescription`
     → "Franco uses the microphone for speaking practice."
2. Set **Version = 1.5** and bump **Build** number.
3. **Product → Archive** → **Distribute App** → upload to App Store Connect.
4. In App Store Connect, attach the build to the 1.5 version → **Submit for Review**.

> ⚠️ `APP_VERSION` in `src/FrancoApp.jsx` is set to `"1.5"` and must match the Xcode Version,
> or the in-app update banner will misfire.

---

## After 1.5 is approved & live: OTA updates (no review)
Capgo is already set up (app `app.franco.www`, channel `production`).
Once users are on 1.5+, push JS-only fixes instantly with:
```
npm run build
npx @capgo/cli bundle upload --channel production --apikey e1c2de79-4a7d-4397-aa4c-5037c3b0711e
```
(Keep that API key private — treat it like a password.)

---

## Optional: turn on the HeyGen live video call
1. `npm i @heygen/streaming-avatar`
2. Set `HEYGEN_API_KEY` in Vercel → redeploy
3. In `src/FrancoApp.jsx`: set the real **Interactive Avatar** id in `HEYGEN_AVATAR_ID`
   and change `HEYGEN_ENABLED = false` → `true`
4. Test a live call on a real iPhone BEFORE shipping it on (or ship it via Capgo OTA after testing)
