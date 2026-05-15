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

async function loadPurchases() {
  if (_purchases) return _purchases;
  try {
    const mod = await import("@revenuecat/purchases-capacitor");
    _purchases = mod.Purchases || mod.default;
    return _purchases;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[iap] @revenuecat/purchases-capacitor not installed:", e?.message);
    return null;
  }
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
  const Purchases = await loadPurchases();
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
  const Purchases = await loadPurchases();
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
  const Purchases = await loadPurchases();
  if (!Purchases) return null;
  try {
    const result = await Purchases.getOfferings();
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
  const Purchases = await loadPurchases();
  if (!Purchases) throw new Error("IAP plugin not available.");
  if (!pkg) throw new Error("No package to purchase.");
  try {
    const result = await Purchases.purchasePackage({ aPackage: pkg });
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
  const Purchases = await loadPurchases();
  if (!Purchases) throw new Error("IAP plugin not available.");
  try {
    const result = await Purchases.restorePurchases();
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

// Convenience check — does the user currently have premium?
export function isPremiumActiveLocal() {
  try {
    const v = localStorage.getItem(ENTITLEMENT_KEY);
    if (!v) return false;
    const { token, exp } = JSON.parse(v);
    return token === "unlocked" && Date.now() < exp;
  } catch { return false; }
}
