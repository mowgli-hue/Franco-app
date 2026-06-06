# Franco App — Project Handoff / Context Recap

_Last updated: 2026-06-06. Paste this into a new chat to continue with full context._

---

## 1. What Franco is

- **Franco** = a freemium **French-learning iOS app for Canadian immigrants** (CLB / TEF Canada prep — the French benchmark for Express Entry PR points).
- **Stack:** Capacitor 8 wrapping a **React + Vite** web app. Hosted on **Vercel** (web). iOS shipped via Xcode → App Store Connect.
- **Payments:** Apple **In-App Purchase** via **RevenueCat** (StoreKit 2). Subscription = **$19.99/month** ("Franco Premium"). Web previously used Stripe (8 legacy Stripe subscribers still exist — see §6).
- **Auth:** Firebase auth exists (email/password) but iOS runs **guest-only** (anonymous) — no login/identity on iOS yet. No Firestore progress-sync yet.
- **Owner:** Lavisha Dhingra / Jungle Labs. Related business: **Nimmi** (immigration services, www.nimmi.solutions).

### Key file paths (note: the project path has a SPACE in it)
- Project root: `/Users/junglelabs/Documents/New project/franco-app`
- Main app (~5000 lines): `src/FrancoApp.jsx`
- IAP logic: `src/iap.js`
- Sound/haptics: `src/feedback.js`
- Firebase: `src/firebase.js`
- Vite config: `vite.config.js`
- `.env`: `VITE_REVENUECAT_KEY=appl_rbwObpGblZPzrhkuuqJmtDkfxAo`

### Build / deploy commands
```
npm run build && npx cap sync ios
```
Then in Xcode: **Clean Build Folder (Shift+Cmd+K) → Run** (delete app from phone first if old code persists).
Important Xcode setting: **Build Settings → User Script Sandboxing = No** (the space in the path otherwise triggers a "Sandbox: bash deny file-read-data" build failure).

---

## 2. THE BIG WIN — IAP "stuck on Processing" bug (SOLVED)

Subscriptions were freezing on "Processing" for weeks; customers couldn't pay. Root cause chain (all now fixed):
1. Apple **Paid Applications Agreement** wasn't active → user signed it (+ W-8BEN-E tax form, banking).
2. RevenueCat product showed "Could not check" → fixed by uploading App Store Connect API key → product "Approved."
3. **The real root cause — the "thenable-proxy" bug:** Capacitor's `registerPlugin` returns a Proxy that returns a function for ANY property, **including `.then`**, which makes it look like a Promise ("thenable"). The old `loadPurchases()` was `async` and **returned that proxy** → JS `await`ed its fake `.then()` → **infinite hang**.
   - **Fix:** made `loadPurchases()` **synchronous** and removed every `await loadPurchases()` (5 call sites). Also added `withTimeout()` wrappers so a call can never hang forever, and `iapDiagnose()` for on-device diagnostics.
   - `vite.config.js` uses `inlineDynamicImports: true` (single bundle) because Capacitor's iOS WKWebView hangs on lazy/cross-chunk JS.
- **Status: user confirmed "working finally."** Real purchases go through.

---

## 3. What we fixed THIS session (all done + validated, in `src/FrancoApp.jsx` and `feedback.js`)

1. **Write-answer grading bug** — wrong/gibberish/blank written answers were passing as "Perfect ⭐." The AI grader prompt was too lenient ("if mostly correct, mark correct:true"). Rewrote the grading rules to mark **false** for empty/gibberish/English/off-topic answers, **true** only when the French genuinely communicates the meaning (minor spelling/accent OK). Also tightened the fallback so short fragments (e.g. "ans") don't false-match inside words (e.g. "dans"). _User tested: correct works; this was the remaining complaint — should now be fixed, needs final on-device confirm._
2. **Wrong-answer feedback too verbose** — trimmed to a short correction + ~3-word encouragement + one short sentence; removed the extra grammar-note block.
3. **Lesson alignment / notch overlap** — the lesson screen renders WITHOUT the global top bar (`showNav` excludes `"lesson"`), but its header was positioned as if a 52px bar sat above it and had no safe-area padding. Fixed: lesson headers now stick at `top:0` with `paddingTop: env(safe-area-inset-top)`, and the lesson fills full height. _User confirmed: "alignment is good."_
4. **Correct-answer sound** — changed `playCorrect()` from a 2-note chime to a clear **bell** (C6 strike + G6 shimmer) in `feedback.js`.
5. **8 real lesson content bugs** found via a full structural audit (190 lessons / 957 questions) and fixed:
   - `f-04` "twenty-five dollars" word-order had an extra "et" tile (unanswerable) — removed it (25 = *vingt-cinq*, no *et*).
   - 7 questions with **duplicated answer options**: `f-02` café & hôpital (×2) pronunciations, `a1-15` (Mes×2→Ton), `a1-26` (propriétaire×2→voisin), `a1-29` (le mois×2→la semaine), `b1-03` (remplissez×2→remplir).
   - Re-validation now reports **0 structural issues**; file parses clean.

### Earlier-this-session profile/UX changes (already in place)
- "Immigration Services — Nimmi" and "Calculate Your PR Score — Nimmi" rows → open www.nimmi.solutions.
- Contact rows: Email (admin@junglelabsworld.com), Call/WhatsApp (+1 604 902 8699).
- `openExternal()` helper uses Capacitor Browser on iOS (fixes dead external links).
- Email-verification row hidden in guest mode.
- Removed the debug diagnostic button from the paywall (production cleanup).

---

## 4. CLB 7 content review (IMPORTANT findings)

I audited the curriculum for whether it actually prepares users for **CLB 7** (≈ CEFR B2, the Express Entry French benchmark on TEF/TCF Canada).

**Curriculum structure (190 lessons):**
- FOUNDATION (20), A1 (40), A2 (40), B1 (40), B2 (30), CLB (20).
- Lower tiers (Foundation/A1/A2) are **rich and interactive**: tap, match, fill, scene, order, write, speak.
- **B1 / B2 / CLB collapse to only MCQ + 1 write per lesson** — exactly the levels where CLB 7 is built.

**The design is strong:** grammar scope is correct for B2/CLB 7 (subjunctive, passive all tenses, plus-que-parfait, futur antérieur, gérondif, conditional perfect, concessives, relative *dont*, reported speech, pronoun order, nominalization, emphatic *c'est…que*). Teaching text is accurate and Canada-specific (Radio-Canada, La Presse, Le Devoir, Charte de la langue française, TEF Canada, logos/pathos/ethos). Write prompts are pitched right (200-word essay) with real C1 phrasing. The **AI writing checker is the strongest CLB-relevant feature.**

**The critical gap:** the "Listening / Speaking / Reading" lessons in B1/B2/CLB **don't actually train those skills — they quiz you _about_ them.** Confirmed in data: across all of B1+B2+CLB there are **0 speaking tasks and 0 audio**, and "Reading" lessons have **no actual passage**. E.g. "CLB 7 Listening: Complex Audio" has no audio (asks what *l'implicite* means); "CLB 7 Speaking: 3-Minute Monologue" never has you speak; "Reading: News Article" asks what *le chapeau* is instead of giving an article. Plus the top tiers are thin (CLB 7 band clb-14→17 = ~12 items total).

**Bottom line:** Franco is a **solid CLB 4–6 knowledge-builder + excellent grammar/writing trainer**, but **not yet a standalone path to CLB 7.** Avoid "get to CLB 7 / TEF guaranteed" marketing claims until the gap is closed. The engine already supports the fixes (TTS + `speak` type are used in Foundation; `scene`/`story` supports long text in A2) — the upper tiers just stopped using them.

---

## 5. What the user wants NEXT (open / not yet started)

User reports **real users now subscribing**, and **reviews say the app is "less engaging."** Worried users will hit B1, find it hollow, and churn. User asked to:
- **Complete / upgrade the hollow upper-tier lessons** (B1+) so they actually train skills.
- **Research a good CLB/TEF syllabus** and build **proper modules/lessons** from it.
- **Add skill-focused practice** — either skill-focused modules "after a while," or a dedicated **"Skills" tab** (e.g. Listening, Speaking, Reading, Writing, Grammar, Vocabulary on demand).

**Open decisions to make at the start of the next chat:**
1. **Ship timing** — recommended: ship **v1.4 now** (working IAP + all the bug/polish fixes above) to the real paying users, then do the content overhaul as **v1.5**. Alternative: hold and bundle.
2. **Scope** — (a) new "Skills" tab, (b) upgrade existing B1/B2/CLB lessons to real skill practice (audio listening, `speak` tasks, real reading passages), or (c) both.
3. **Engagement mechanics** — reviews said "less engaging": consider streaks, daily goals, XP/levels/badges, spaced-repetition review.

---

## 6. Other pending items / known context

- **Ship v1.4** (Task #47, pending): bump Version=1.4 / Build=5 in Xcode, ensure User Script Sandboxing=No, Archive → Upload, create v1.4 in App Store Connect, attach build, Submit for Review.
- **Two lesson-polish items still NOT built** (deferred): completed lessons get a **✓ tick + collapse**, and an **"ask Sophie / I have a doubt"** button inside questions.
- **8 legacy Stripe web subscribers** — cannot be granted premium per-user on iOS because the app is guest-only (anonymous RevenueCat IDs, no email/identity to target). Recommended path: they keep web access; build **login + Firestore progress sync + RevenueCat appUserID linking + server-side Stripe reconciliation** as a v1.5 feature.
- **Syllabus file** referenced: `syllabus/franco_syllabus_v2_1_LAUNCH.md` (a deeper review of it was requested earlier, not yet done).

### App Store rejection history (all addressed)
- Guideline 3.1.2(c): missing Terms of Use/EULA link → added in-app (paywall) + App Store metadata.
- Guideline 2.1(b): IAP loading indefinitely → fixed (see §2).
- Earlier: account-deletion (5.1.1(v)) sidestepped by iOS guest-only (no account creation); screenshots (2.3.3) addressed.

### Constraints / how the user works
- The user enters all passwords/credentials and signs all legal agreements (Paid Apps Agreement, W-8BEN-E, API keys / .p8 downloads) **themselves**. Assistant must not create accounts, type passwords, or execute financial transfers.
- The user writes quickly with typos; prefers the assistant to "use your mind everywhere you can" and not cram unverified UI changes.
