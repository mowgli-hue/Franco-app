# App Store Connect — Reply to Apple

Use this when replying to App Review in App Store Connect. Copy-paste the relevant sections into the App Review Information → Notes field, AND into the message reply.

---

## TL;DR — what changed in this build

To address all three previous rejection points, we have fundamentally restructured the iOS build:

1. **No external payment links (3.1.1)** — The iOS app has NO paywall at all. All 190 lessons are free. We do not link to Stripe or any external payment processor from within the iOS app. There is no "Premium" tier, no lock icons, no "Subscribe" button — anywhere — in the iOS build.

2. **No account creation, hence no deletion required (5.1.1(v))** — The iOS app is guest-only by design. Users cannot create an account, log in, or sign in within the app. Since the app does not offer account creation, the account-deletion requirement does not apply. (We did, however, add a "Delete all my data" button in Profile that wipes all locally stored progress — see steps below.)

3. **Screenshots updated (2.3.3)** — New screenshots have been uploaded showing the actual lesson UI, practice screens, and dashboard in use. Marketing/splash/login screens have been removed.

4. **Support URL working (1.5)** — https://franco.app/support is fully functional with our current production deployment.

---

## Detailed answers to Apple's earlier questions (Guideline 2.1(b))

**1. Who are the users that will use the paid content in the app?**

In the iOS app, there is no paid content — all lessons are free. Premium content exists ONLY on our web platform (www.franco.app), where users can optionally subscribe via Stripe. Web premium subscribers are typically Canadian immigrants and students preparing for CLB / TEF Canada exams.

**2. Where can users purchase the content that can be accessed in the app?**

In the iOS app: nowhere — all content is free. Users cannot purchase anything from within the iOS app.

On the web (www.franco.app): users can subscribe via Stripe. The iOS app does NOT link to this; iOS users get all lessons free.

**3. What specific types of previously purchased content can a user access in the app?**

None. The iOS app has no concept of "previously purchased content." All 190 lessons are accessible to every iOS user without any payment, account, or login.

**4. What paid content, subscriptions, or features are unlocked within the app that do not use In-App Purchase?**

None. The iOS app has zero paid content and no subscription features. Apple's Guideline 3.1.1 concern does not apply because we have removed all paid digital content from the iOS build.

**5. Can users purchase physical goods or services together with digital content in your app?**

No. There is nothing to purchase in the iOS app at all.

---

## Demo / testing instructions for App Review

**To verify "Delete all my data" (data control feature):**

1. Open the app
2. Tap **"Profile"** in the bottom navigation
3. Scroll to the bottom of the Profile screen
4. Tap **"Delete all my data"** (red bordered button)
5. Confirm the alert
6. App reloads with all progress cleared

(Note: this is NOT account deletion — there is no account in iOS to delete. It is data control for guest-mode users. The app does not require or offer account creation on iOS.)

**To verify all lessons are free (no paywall):**

1. Tap **"Learn"** in the bottom navigation
2. Tap any lesson, including those in advanced sections (B1, B2, CLB)
3. Lesson opens directly — no paywall, no upgrade prompt, no external links
4. All 190 lessons are accessible

**To verify support URL:**

Navigate to https://franco.app/support in any browser. Working webpage with contact info and FAQs.

---

## Web vs. iOS — clarification per Guideline 3.1.3(b)

The web version of Franco (www.franco.app) does offer a Stripe subscription for premium features. This is allowed under Guideline 3.1.3(b) ("Multiplatform Services") — apps that offer paid services across multiple platforms may allow customers to access content acquired outside the app, AS LONG AS that content is also available via In-App Purchase.

In our case, we have chosen a different approach: **the iOS app simply makes all content FREE for iOS users.** This eliminates any need for IAP because there are no paid features in the iOS app. We explicitly do NOT cross-promote, link to, or mention the web subscription anywhere in the iOS app.

This approach is more conservative than Guideline 3.1.3(b) allows, and we believe it fully satisfies Guideline 3.1.1.

---

## Build / version info

- **Bundle ID:** app.franco.www
- **Version:** 1.0
- **Capacitor:** 8.x with iOS plugin
- **Latest build:** built from current commit on main branch
- **App content:** 190 lessons (Foundation 20, A1 40, A2 40, B1 40, B2 30, CLB 20)

---

## Screenshots provided (2.3.3)

We have uploaded new screenshots for both 6.5" iPhone and 13" iPad showing:

1. Dashboard with progress (Sophie AI tutor visible, lesson stats, "Continue Learning" card)
2. Learn hub showing the Foundation module with lessons listed
3. A lesson in progress (Bonjour Canada!) with vocabulary cards and interactive questions
4. Practice screen with multiple game modes (Tap, Match, Fill, Choose, Story, Build, Write)
5. AI Conversation Partner mode in action
6. Profile with progress tracking, achievements, and "Delete all my data" option visible

No splash, login, or marketing screens have been included in the screenshot set.
