# Franco — Changes & Current State (handoff prompt)

Paste this into a new session (or give a developer) to continue seamlessly. It
captures everything changed, the live state, feature flags, and what's pending.

App: Franco — freemium French-learning iOS + web app for Canadian immigrants
(CLB / TEF Canada / TCF Canada prep). Capacitor 8 + React + Vite, single bundle.
Main file: `src/FrancoApp.jsx`. Repo: github.com/mowgli-hue/Franco-app.

---

## CURRENT LIVE STATE
- **App Store: v1.5 approved & "Ready for Distribution"** (live / rolling out).
  App ID 6761284189, bundle id `app.franco.www`, Firebase project `clb-french-trainer`.
- **Capgo OTA: active (paid Solo plan).** App + `production` channel set up.
  Latest bundle uploaded = **1.5.2**. `package.json` version bumped to drive the CLI.
  Push future JS fixes with: `npm run build && npx @capgo/cli bundle upload --channel production --apikey <KEY>`
- **OTA reaches users only once they're on the 1.5 binary** (which contains the plugin).

## SHIPPED IN 1.5 (App Store binary)
- Real **native speech recognition** for speaking questions (Apple Speech via
  `@capacitor-community/speech-recognition`) + can't-get-stuck guard.
- **Mid-lesson progress save/resume** (`readLessonProg`/`writeLessonProg`).
- **Word Rush mini-game** (Foundation lessons) + auto `buildVocabPractice` questions.
- **Sound button** on match questions; story "Listen" uses Sophie's ElevenLabs voice.
- Removed **"Claude"/AI vendor naming** from lesson UI (Sophie-branded).
- **In-app "update available" banner** (`APP_VERSION` must match Xcode version — now "1.5").
- **Capgo OTA plugin** + **local-notification daily reminder** (Profile toggle).
- Info.plist: `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`,
  `ITSAppUsesNonExemptEncryption=false`.

## SHIPPED VIA OTA (bundle 1.5.2, on top of 1.5)
- Audio now **stops on every slide/question/page change** (was continuing).
- Latest review fixes (Live Sophie stale-history bug, spoken-error bug, speaking-coach
  unmount leak, blob revoke, gentler 2.2s silence auto-submit, mic-denied messaging).

## NEW FEATURES — FLAGGED (in code, controllable)
- **Live Sophie (owned, free)** — `SOPHIE_LIVE_ENABLED = true`. Animated portrait
  (`public/sophie-live.png`) that talks in Sophie's ElevenLabs voice; mic in (native
  speech recognition, auto-submit on pause) + type; floating "📹 Talk to Sophie"
  button on all main screens. NOTE: needs `public/sophie-live.png` dropped in, else
  shows a fallback teacher icon.
- **HeyGen live call (photorealistic, premium-only)** — `HEYGEN_ENABLED = false`.
  When true, the floating button routes premium users into a real HeyGen Interactive
  Avatar call (`LessonVideoCall`) and non-premium to the paywall. To enable:
  1. Create a HeyGen **Photo/Interactive Avatar** of Sophie → copy its streaming
     **Avatar ID** into `HEYGEN_AVATAR_ID`.
  2. `npm i @heygen/streaming-avatar`.
  3. Set `HEYGEN_API_KEY` in Vercel (powers `api/heygen-token.js`).
  4. Set `HEYGEN_ENABLED = true`. (Bills per streaming minute — premium-gated for cost.)

## KEY FILES
- `src/FrancoApp.jsx` — everything (lessons, screens, Live Sophie, HeyGen call, flags).
- `src/sophie.js` — Sophie's system/teaching prompt (`buildSophieSystemPrompt`).
- `src/iap.js` — RevenueCat (Apple IAP). `src/notifications.js`, `src/liveupdate.js`.
- `api/tts.js` (ElevenLabs), `api/claude.js` (Sophie brain), `api/heygen-token.js`.
- Env: Vercel needs `ELEVENLABS_API_KEY`, Claude key, (HeyGen key when enabling).

## BUILD / SHIP
- Web/API: `git push` → Vercel auto-deploys.
- iOS: bump Version+Build in Xcode → Archive → upload → submit. Bump `APP_VERSION`
  in code to match. `npm run build && npx cap sync ios` before archiving.
- OTA (JS only): `npm run build && npx @capgo/cli bundle upload --channel production`.

## PENDING / NEXT
- [ ] Drop `public/sophie-live.png` (+ optional `sophie-live-open.png` for 2-frame mouth).
- [ ] Finish HeyGen Photo Avatar → set `HEYGEN_AVATAR_ID` + key → flip `HEYGEN_ENABLED`.
- [ ] Grant client premium: add `scgladys@hotmail.com` to Firestore `premiumUsers`
      {premium:true, exp, grantedAt} (admin panel hits permission error; use Console).
- [ ] **Performance:** 1.3MB single bundle; Firebase loads eagerly. `vite.config.js`
      forces `inlineDynamicImports` (defeats code-splitting). Lazy-load Firestore +
      revisit the WKWebView chunk constraint. (Own task — device-test risk.)
- [ ] **SECURITY:** the Capgo API key was committed in `RELEASE-1.5.md` and pushed to
      GitHub — rotate it in Capgo and remove from the repo / add to .gitignore.
- [ ] Refresh App Store screenshots (still show old "AI Conversation Partner" wording).
- [ ] RevenueCat: also re-validate entitlement on `@capacitor/app` resume (not only
      web `visibilitychange`).
