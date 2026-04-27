# Franco App — Full Audit Report
*Generated April 21, 2026*

## 1. Live Site Status — FIXED ✅

- `www.franco.app` was rendering a blank white screen.
- Root cause: `ReferenceError: totalXP is not defined` inside the `DashboardScreen` component (`src/FrancoApp.jsx` ~line 2362). The function was defined in `HubScreen` but not in `DashboardScreen`, which referenced it.
- Fix committed in `d52e636 Fix: define totalXP and streak helpers in DashboardScreen`.
- All four screens now render: Home, Learn, Practice, Profile. Console is clean (no runtime errors on new bundle `index-CLurh9W8.js`).

---

## 2. App Store Rejection — Action Required

### 2a. Guideline 3.1.1 — In-App Purchase (BLOCKER)

**Apple's complaint:** "The app accesses digital content purchased outside the app, such as the paid subscriptions, but that content isn't available to purchase using In-App Purchase."

**Where in the code:**
- `src/FrancoApp.jsx` line 2194: `STRIPE_PUBLISHABLE_KEY = "pk_live_…"` (hardcoded)
- Line 2195: `STRIPE_PAYMENT_LINK = "https://buy.stripe.com/7sY6oIaaYfe6c0K6Di2go00"`
- Line 2196: `PRICE_DISPLAY = "$49/month"`
- Lines 2203–2221: `isPremiumUnlocked()`, `checkStripeSuccess()` — uses localStorage and URL params
- Lines 2224–2284: `PaywallModal` — opens Stripe checkout in `window.open(link, "_blank")`
- Lines 2535–2547: Lesson lock UI (🔒 "Premium" / "Unlock" badges)
- Line 3565: `openLesson` → triggers paywall if `!isLessonFree && !isPremiumUnlocked`
- Line 3639: PaywallModal rendered when `paywallLesson` is set

**Why Apple rejects:** On iOS, digital subscriptions (premium learning content) MUST use Apple's In-App Purchase (StoreKit). Linking out to Stripe Checkout for a digital subscription is a straight violation.

**Two options to resolve (pick one):**

**Option A — Make the app fully free (easiest, fastest path to approval):**
1. Remove `PaywallModal`, `isPremiumUnlocked`, `checkStripeSuccess`, `STRIPE_PAYMENT_LINK`, `FREE_LESSON_IDS`
2. Remove `locked` / `⭐ Premium` / `Unlock` UI from the lesson list
3. Remove the `useEffect(()=>{checkStripeSuccess();},[]);` at line 3499
4. Remove lesson-gating in `openLesson` (lines 3564-3566)
5. Rebuild and `npx cap sync ios`
6. The Welcome screen already advertises "100% Free · No Paywall · No Ads" — this would make it accurate

**Option B — Keep subscriptions, use proper IAP on iOS:**
1. Install a Capacitor IAP plugin: `npm i @capacitor-community/in-app-purchases` (or RevenueCat, which is widely recommended)
2. Create the subscription product in App Store Connect (App Store Connect → My Apps → Subscriptions)
3. Detect platform: if `Capacitor.getPlatform() === 'ios'`, use IAP; if web, keep Stripe
4. Implement restore-purchases flow (Apple requires a "Restore Purchases" button on iOS)
5. Store entitlement server-side or via secure receipt validation (not just localStorage, which is trivially faked)
6. Add subscription terms URL and privacy policy URL in App Store Connect
7. Much more work — budget 1-2 days of focused dev

My recommendation: **Option A** for this resubmission. Ship free, get approved, add proper IAP in a future update if you want to monetize. Apple is much more strict on IAP violations than on pricing model changes.

---

### 2b. Guideline 5.1.1(v) — Account Deletion (BLOCKER)

**Apple's complaint:** "The app supports account creation but does not include an option to initiate account deletion."

**Where in the code:**
- The **current** `src/FrancoApp.jsx` has NO Firebase auth code — `grep` finds zero `createUserWithEmailAndPassword`, `signInWithEmailAndPassword`, `deleteUser`, etc.
- But the **iOS bundle you submitted to Apple** (`ios/App/App/public/assets/index-BXNOJsS6.js`, dated April 2) DOES contain `signOut` and Firebase references from an older build.
- The `AUTH_SETUP.md` in the root describes the old auth flow: AuthLandingScreen → LoginScreen → RegisterScreen → email verification.
- In other words: your iOS submission still has the old auth code. The web version has been simplified to anonymous-only (localStorage for progress).

**How to resolve — two options:**

**Option A — Keep it anonymous-only (matches current web):**
1. Delete `ios/App/App/public/assets/*.js` (the old bundle)
2. Run `npm run build && npx cap sync ios` to copy the new (auth-less) bundle over
3. Delete `src/AUTH_SETUP.md` since it doesn't apply anymore
4. No accounts = no account deletion requirement. Done.

**Option B — Re-add auth and add account deletion:**
1. Restore the old auth flow (Firebase)
2. Add a "Delete my account" button in ProfileScreen
3. On click: confirmation dialog → re-authenticate → `firebase.auth().currentUser.delete()` → clear localStorage → navigate to landing screen
4. Must also delete any user data in Firestore/RTDB if you have any
5. Must be reachable without customer service (per Apple's wording)

My recommendation: **Option A** — fastest path, matches your current web UX.

---

### 2c. Guideline 2.3.3 — Screenshots (metadata, not code)

**Apple's complaint:** "The 6.5-inch iPhone and 13-inch iPad screenshots do not show the actual app in use in the majority of the screenshots."

**What you need to do** (in App Store Connect, not in code):
1. Take fresh screenshots on actual devices (or simulators):
   - **6.5" iPhone** — iPhone 11 Pro Max / 12 Pro Max / 14 Plus / 15 Plus / 16 Plus simulator, at 1242×2688
   - **13" iPad** — iPad Pro 12.9" simulator, at 2048×2732
2. Capture 5-7 screenshots showing **actual app screens in use**, not marketing/splash/login:
   - A lesson mid-completion (vocab cards flipped, question being answered)
   - The Learn hub with level progress visible
   - A practice game in action (Speed Recall timer, Word Match mid-game)
   - The Dashboard with some XP / streak populated
   - Profile screen showing progress bars
3. Upload via App Store Connect → App → iOS App → [Version] → Previews and Screenshots → "View All Sizes in Media Manager"
4. **Skip these as screenshots** — Apple generally won't accept: marketing banners, promo art with heavy text overlays, splash screen, login/signup screens, completely empty states

---

## 3. Other Issues Found (non-blocking but worth fixing)

### 3a. Environment variable files committed to git (security hygiene)
- `env (1)` and `src/env` contain Firebase API keys and are **tracked in git** (public on GitHub).
- `.gitignore` ignores `.env` (with dot) but not `env` (without dot).
- Firebase web API keys are designed to be exposed (it's a client identifier, not a secret), so this isn't a breach — but clean up anyway:

```
git rm --cached "env (1)" src/env
echo -e "env\nenv (*)\n*.env*" >> .gitignore
git commit -m "Stop tracking env files"
```

### 3b. React Rules of Hooks violation (potential bug)
- Line 2691: `useState` is called inside a `.map()` callback. This only works because vocab arrays never change length — but it's fragile. If that array ever becomes dynamic, expect crashes.
- Fix: hoist flip state to a Map keyed by vocab string at the parent level.

### 3c. Empty `catch` blocks (silent failures)
- Lines 2219, 2988, 2992 — errors are swallowed. If Stripe localStorage writes fail or something else breaks, no one will know.
- Fix: at minimum, `console.warn('description', e)` inside each catch.

### 3d. Misleading Welcome screen text
- Line 2302: Welcome carousel advertises **"🚫 No Paywall"** and **"100% Free"** — but there IS a paywall in the app.
- Fix: Either actually remove the paywall (Option A above) OR remove these badges. Apple reviewers may spot this inconsistency and flag it under Guideline 2.3 (accurate metadata).

### 3e. Dead code / unused imports (28 eslint errors)
- Many unused variables, one empty statement, a few missing-dependency warnings. Cosmetic but worth a cleanup pass.

### 3f. Two copies of FrancoApp.jsx
- `FrancoApp.jsx` (537 KB, root) and `FrancoApp.jsx.bak` (523 KB, src) are old copies. Only `src/FrancoApp.jsx` is bundled.
- Fix: `git rm FrancoApp.jsx src/FrancoApp.jsx.bak` — reduce confusion.

---

## 4. Recommended Path to Resubmission

**Shortest path (2-4 hours of work):**

1. Strip the paywall entirely (Option A for 3.1.1)
2. Rebuild and sync iOS (`npm run build && npx cap sync ios`) — the synced bundle will no longer have the auth code either, resolving 5.1.1(v)
3. Capture proper 6.5" iPhone and 13" iPad screenshots showing lessons/practice/dashboard in use
4. Upload screenshots to App Store Connect
5. Resubmit for review

I can help you implement step 1 (code removal) right now if you'd like — I'd modify `src/FrancoApp.jsx` to remove all the Stripe/paywall/premium code in one pass and verify the build succeeds.

Let me know which approach you want: **free-tier Option A** (fastest), or do you want to keep subscriptions and go the full IAP route?
