// Apple In-App Purchase via RevenueCat for the Franco iOS app.
//
// Flow:
//   1. iapInit() — call once on app load (only on iOS)
//   2. iapGetOfferings() — fetch the Premium subscription product
//   3. iapPurchase(pkg) — launch Apple's IAP sheet
//   4. iapRestore() — restore previous purchases
//   5. isPremiumActive() — check if user has active subscription
//
// The app uses Apple's StoreKit (managed by RevenueCat) to handle:
//   - Subscription billing through Apple
//   - Receipt validation
//   - Renewal tracking
//   - Restore purchases on reinstall
//
// Setup required (one time):
//   1. App Store Connect → Subscriptions → create "Franco Premium Monthly" product
//   2. RevenueCat dashboard → connect App Store Connect API key
//   3. Add the subscription product to RevenueCat → create entitlement "premium"
//   4. Get RevenueCat API key (Public SDK key) → put in .env as VITE_REVENUECAT_KEY

// Static import — load the RevenueCat SDK with this module instead of via a
// lazy dynamic import(). Dynamic-import chunks fail to load in the iOS Capacitor
// WebView (they hang forever), which prevented the SDK from ever initializing.
// Bundling it statically with iap.js (which loads fine) fixes the hang.
import { Purchases as RCPurchases } from "@revenuecat/purchases-capacitor";

const REVENUECAT_KEY = import.meta.env.VITE_REVENUECAT_KEY || "";
const ENTITLEMENT_ID = "premium"; // Must match what you create in RevenueCat
const ENTITLEMENT_KEY = "franco_premium"; // localStorage key (compatible with existing isPremiumUnlocked)

const IS_IOS = (() => {
  try {
    return typeof window !== "undefined" &&
      window.Capacitor?.getPlatform?.() === "ios";
  } catch { return false; }
})();

let _purchases = null;
let _initialized = false;

// Wrap a promise so it can never hang forever. If `p` doesn't settle within
// `ms`, reject with a clear, user-facing message. This is what prevents the
// paywall button from spinning indefinitely when StoreKit returns nothing
// (e.g. Paid Apps Agreement not active, or sandbox hiccup).
function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(label || "The App Store took too long to respond. Please try again."));
    }, ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// Mirror RevenueCat's entitlement state into localStorage so the existing
// isPremiumUnlocked() function (which reads localStorage) keeps working
// without a refactor. The ground truth is RevenueCat — this is a UI cache.
function syncToLocalStorage(isActive, expiresAt) {
  try {
    if (isActive) {
      const exp = expiresAt ? new Date(expiresAt).getTime() : Date.now() + 31 * 24 * 60 * 60 * 1000;
      localStorage.setItem(ENTITLEMENT_KEY, JSON.stringify({ token: "unlocked", exp }));
    } else {
      localStorage.removeItem(ENTITLEMENT_KEY);
    }
  } catch { /* ignore */ }
}

// IMPORTANT: this is a SYNCHRONOUS function (not async). The RevenueCat plugin
// object is a Capacitor Proxy that returns a function for ANY property —
// including `.then` — which makes it look like a "thenable" / promise. If an
// async function RETURNS it (or anything `await`s it), JS calls its fake
// `.then()` and hangs forever. THIS was the root cause of the purchase hang.
// So we must never await the plugin object — only call its real methods.
function loadPurchases() {
  if (_purchases) return _purchases;
  if (!RCPurchases) {
    // eslint-disable-next-line no-console
    console.warn("[iap] @revenuecat/purchases-capacitor not available");
    return null;
  }
  _purchases = RCPurchases;
  return _purchases;
}

// Initialize RevenueCat. Call once at app start (only on iOS — no-op on web).
export async function iapInit(userIdentifier = null) {
  if (!IS_IOS) return { ok: true, skipped: "not-ios" };
  if (_initialized) return { ok: true, alreadyInitialized: true };
  if (!REVENUECAT_KEY) {
    // eslint-disable-next-line no-console
    console.warn("[iap] VITE_REVENUECAT_KEY missing — IAP disabled");
    return { ok: false, reason: "no-key" };
  }
  const Purchases = loadPurchases();
  if (!Purchases) return { ok: false, reason: "plugin-missing" };
  try {
    await Purchases.configure({
      apiKey: REVENUECAT_KEY,
      appUserID: userIdentifier || undefined,
    });
    _initialized = true;
    // Pull current entitlement state immediately and mirror to localStorage.
    await refreshEntitlementCache();
    return { ok: true };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[iap] init failed:", e);
    return { ok: false, reason: "init-error", error: e?.message };
  }
}

// Refresh the local entitlement cache from RevenueCat. Called after init,
// after purchase, after restore, and periodically.
export async function refreshEntitlementCache() {
  if (!IS_IOS) return false;
  const Purchases = loadPurchases();
  if (!Purchases) return false;
  try {
    const result = await Purchases.getCustomerInfo();
    const info = result?.customerInfo || result;
    const entitlement = info?.entitlements?.active?.[ENTITLEMENT_ID];
    const isActive = !!entitlement;
    const expiresAt = entitlement?.expirationDate || null;
    syncToLocalStorage(isActive, expiresAt);
    return isActive;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[iap] refreshEntitlementCache failed:", e);
    return false;
  }
}

// Fetch available offerings (what the user can buy). Returns the package
// for the "current" offering, or null if RevenueCat isn't configured.
export async function iapGetOfferings() {
  if (!IS_IOS) return null;
  const Purchases = loadPurchases();
  if (!Purchases) return null;
  try {
    const result = await withTimeout(
      Purchases.getOfferings(), 15000,
      "Couldn't reach the App Store. Check your connection and try again."
    );
    const offerings = result?.offerings || result;
    const current = offerings?.current;
    if (!current) {
      // eslint-disable-next-line no-console
      console.warn("[iap] no current offering — set one in RevenueCat dashboard");
      return null;
    }
    return current;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[iap] getOfferings failed:", e);
    return null;
  }
}

// Launch Apple's IAP purchase sheet for the given package.
// Returns { ok: true, purchased: true } if successful.
export async function iapPurchase(pkg) {
  if (!IS_IOS) throw new Error("In-app purchase only available on iOS.");
  const Purchases = loadPurchases();
  if (!Purchases) throw new Error("IAP plugin not available.");
  if (!pkg) throw new Error("No package to purchase.");
  try {
    const result = await withTimeout(
      Purchases.purchasePackage({ aPackage: pkg }), 120000,
      "The purchase is taking longer than expected. Please try again."
    );
    const info = result?.customerInfo;
    const entitlement = info?.entitlements?.active?.[ENTITLEMENT_ID];
    if (entitlement) {
      syncToLocalStorage(true, entitlement.expirationDate);
      return { ok: true, purchased: true };
    }
    return { ok: false, purchased: false, reason: "entitlement-not-active" };
  } catch (e) {
    // User cancellation isn't really an error — return cleanly.
    if (e?.userCancelled || /cancel/i.test(e?.message || "")) {
      return { ok: true, cancelled: true };
    }
    throw e;
  }
}

// Restore previous purchases (required by Apple — must be exposed in UI).
export async function iapRestore() {
  if (!IS_IOS) throw new Error("Restore only available on iOS.");
  const Purchases = loadPurchases();
  if (!Purchases) throw new Error("IAP plugin not available.");
  try {
    const result = await withTimeout(
      Purchases.restorePurchases(), 60000,
      "Restore is taking longer than expected. Please try again."
    );
    const info = result?.customerInfo;
    const entitlement = info?.entitlements?.active?.[ENTITLEMENT_ID];
    if (entitlement) {
      syncToLocalStorage(true, entitlement.expirationDate);
      return { ok: true, restored: true };
    }
    return { ok: true, restored: false, message: "No previous purchases found." };
  } catch (e) {
    throw e;
  }
}

// ─── Diagnostic ────────────────────────────────────────────────────────────
// Runs init + getOfferings (WITHOUT purchasing) and returns a detailed report
// of exactly what the SDK sees. The paywall surfaces this on-screen so a stuck
// purchase reveals its real cause instead of hiding it in native logs.
export async function iapDiagnose() {
  const r = { diagBuild: "v5-thenable-fix", steps: {} };
  // Run an async step with its own timeout so the diagnostic NEVER hangs and
  // always tells us exactly which step is stuck.
  const step = async (name, factory, ms) => {
    try {
      const v = await withTimeout(Promise.resolve().then(factory), ms, name + " TIMED OUT (" + (ms / 1000) + "s) — this step is hanging");
      r.steps[name] = "ok";
      return { ok: true, value: v };
    } catch (e) {
      r.steps[name] = "ERROR: " + String(e?.message || e);
      return { ok: false, error: e };
    }
  };
  try {
    r.platform = (typeof window !== "undefined" && window.Capacitor?.getPlatform?.()) || "unknown";
    r.keyPresent = !!REVENUECAT_KEY;
    r.keyPreview = REVENUECAT_KEY ? REVENUECAT_KEY.slice(0, 12) + "…" : "(none)";
    r.alreadyInitialized = _initialized;

    // loadPlugin must be SYNCHRONOUS — the plugin proxy is thenable, so passing
    // it through any promise (await / .then) hangs. This was the real bug.
    const Purchases = loadPurchases();
    r.steps.loadPlugin = Purchases ? "ok" : "ERROR: plugin not available";
    if (!Purchases) return r;

    if (!_initialized) {
      const cfg = await step("configure", () => Purchases.configure({ apiKey: REVENUECAT_KEY }), 10000);
      if (cfg.ok) _initialized = true;
    } else {
      r.steps.configure = "already configured at startup";
    }

    const ci = await step("getCustomerInfo", () => Purchases.getCustomerInfo(), 10000);
    if (ci.ok) {
      const info = ci.value?.customerInfo || ci.value;
      r.appUserId = info?.originalAppUserId || null;
    }

    const off = await step("getOfferings", () => Purchases.getOfferings(), 15000);
    if (off.ok) {
      const offerings = off.value?.offerings || off.value;
      const cur = offerings?.current;
      r.hasCurrentOffering = !!cur;
      r.currentOfferingId = cur?.identifier || null;
      r.packageCount = cur?.availablePackages?.length || 0;
      const pkg = cur?.availablePackages?.[0];
      r.firstProductId = pkg?.product?.identifier || null;
      r.firstPriceString = pkg?.product?.priceString || null;
      r.allOfferingIds = Object.keys(offerings?.all || {});
    }
  } catch (e) { r.fatalError = String(e?.message || e); }
  return r;
}

// Convenience check — does the user currently have premium?
export function isPremiumActiveLocal() {
  try {
    const v = localStorage.getItem(ENTITLEMENT_KEY);
    if (!v) return false;
    const { token, exp } = JSON.parse(v);
    return token === "unlocked" && Date.now() < exp;
  } catch { return false; }
}
