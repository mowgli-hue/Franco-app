# Franco — Critical Path to App Store Resubmission

## Work split: me (code) vs. you (accounts + Apple)

### YOU need to do (in parallel — start now):

**A. Set up the IAP product in App Store Connect** (~30-45 min)
1. Sign in to appstoreconnect.apple.com
2. My Apps → Franco → Monetization → Subscriptions
3. Click **+** next to "Subscription Groups" → name it "Franco Premium"
4. Inside the group, click **+** next to "Subscriptions" → create a new subscription
   - **Reference Name:** `Franco Premium Monthly`
   - **Product ID:** `app.franco.www.premium.monthly` ← tell me this exact string when done
   - **Subscription Duration:** 1 Month
5. Fill in the localized info:
   - **Display Name:** "Franco Premium"
   - **Description:** "Unlock all 190 lessons, practice games, and CLB test prep"
6. Set the price: $49.99/month (or whatever tier you want — pick from Apple's price points)
7. Upload a review screenshot (any screenshot of the paywall UI works)
8. Answer the subscription metadata questions (family sharing off, auto-renewing yes)
9. Status should become "Ready to Submit" — good, leave it there
10. Tell me the exact **Product ID** you used

**B. Verify Firebase setup** (~5 min)
1. Firebase Console → clb-french-trainer project → Authentication → Sign-in method
2. Confirm **Email/Password** is enabled
3. (Optional but good) Enable **Google** sign-in too
4. Authentication → Settings → Authorized domains → add `www.franco.app` and `franco.app` if not there

**C. Gather screenshot plan** (~15 min)
Once the code is done, you'll need:
- 6.5" iPhone screenshots: iPhone 15 Plus / 16 Plus simulator (1242×2688 or native 1290×2796)
- 13" iPad screenshots: iPad Pro 12.9" simulator (2048×2732)
- 5-7 screenshots per size showing:
  1. Dashboard with progress
  2. Learn hub (lessons list)
  3. A lesson open with vocab cards / questions
  4. Practice games menu
  5. AI conversation partner
  6. Profile with achievements
  7. Paywall or "Premium" upsell

### I will do (code):

**Phase 1 — Firebase auth scaffolding** (30 min)
- `src/firebase.js` — initialize auth + Firestore
- Move `src/env` → proper `.env` in root + `.env.example`
- Update `.gitignore`

**Phase 2 — Auth UI** (2 hrs)
- `AuthLandingScreen` (feature cards + "Sign up" / "Log in" / "Continue as guest")
- `LoginScreen` (email/password + error mapping)
- `RegisterScreen` (email/password/confirm + email verification send)
- Wire `onAuthStateChanged` in top-level FrancoApp
- Sign-out button in TopBar
- Guest mode preserved (localStorage-only)

**Phase 3 — Account deletion** (30 min)
- "Delete my account" button in ProfileScreen (red, at bottom)
- Confirmation modal ("This cannot be undone…")
- Re-auth prompt (enter password)
- `user.delete()` + clear localStorage + signOut + back to landing
- If Firestore user doc exists, delete that too

**Phase 5 — iOS IAP** (3-4 hrs)
- `npm i @capacitor-community/in-app-purchase-2` (or revenue-cat if you prefer)
- `src/iap.js` wrapper — queryProduct(), purchase(), restore()
- PaywallModal: detect platform, show IAP button on iOS, Stripe button on web
- Listener updates `franco_premium` localStorage + Firestore user doc on success
- "Restore Purchases" button (required by Apple)

**Phase 6 — Cleanup** (20 min)
- Remove misleading "No Paywall" Welcome badges
- Remove `FrancoApp.jsx` root duplicate + `src/FrancoApp.jsx.bak`
- Run eslint, fix top errors

**Phase 7 — Ship** (1 hr with you)
- `npm run build` + `npx cap sync ios`
- Open Xcode, build, test on simulator together
- Commit + push to GitHub
- You take screenshots, upload to App Store Connect
- Submit for review

## Total estimated: ~8 hours of work

I'll move quickly through Phases 1-3 and 6 (the parts that don't depend on your App Store Connect setup). By the time you're done with A/B/C above, I should be ready to plug in Phase 5 using your product ID.

## What we're explicitly NOT doing this round (follow-up session):
- Firestore progress sync (local-only for now; sync added after approval)
- Proper Stripe webhook + entitlement on backend (web just hides IAP button; Stripe unchanged)
- Lesson content review and fixes
- UX polish, accessibility, perf
