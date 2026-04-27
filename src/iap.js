// iOS In-App Purchase integration for Franco Premium.
//
// Apple requires digital subscriptions on iOS to use IAP (App Store
// guideline 3.1.1). On web we keep the existing Stripe flow; this module is
// ONLY called when running inside the iOS Capacitor wrapper.
//
// We use the `@capacitor-community/in-app-purchases` plugin (installed via
// `npm i @capacitor-community/in-app-purchases` and `npx cap sync ios`).
//
// If the plugin isn't installed yet (e.g. the user hasn't run `npm install`
// yet), the lazy dynamic import will throw — we wrap every call so the app
// continues to work on web and never crashes in the UI.
//
// Flow (PaywallModal uses these helpers):
//   1. iapInit()        — call once at app load to register the product
//   2. iapBuy()         — launches the native purchase sheet
//   3. iapRestore()     — restores entitlement from App Store receipts
//   4. onEntitlementChange(cb) — listener; fires when subscription becomes
//      active or expires. We flip localStorage("franco_premium") accordingly
//      so existing isPremiumUnlocked() keeps working unchanged.

const PRODUCT_ID = "Franco_123"; // Must match exactly the product ID in App Store Connect.
const ENTITLEMENT_KEY = "franco_premium";

// Grant premium for 31 days locally. For a proper production setup, validate
// the receipt server-side and store an entitlement in Firestore keyed by uid.
function grantLocalEntitlement(days = 31) {
  try {
    const exp = Date.now() + days * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      ENTITLEMENT_KEY,
      JSON.stringify({ token: "unlocked", exp })
    );
  } catch {
    /* private mode or quota — silently ignore */
  }
}

function clearLocalEntitlement() {
  try {
    localStorage.removeItem(ENTITLEMENT_KEY);
  } catch {
    /* ignore */
  }
}

// Load the plugin lazily so the web bundle doesn't try to resolve a native
// module that doesn't exist on web.
// The IAP plugin is loaded via runtime-only dynamic import. The @vite-ignore
// comment tells Vite NOT to try to resolve this at build time — on web the
// package doesn't exist and that's fine. The iOS build installs the real
// package via `npx cap sync ios` after `npm i <plugin>`.
//
// Plugin choice — the team should pick one and install it before TestFlight:
//   - RevenueCat's @revenuecat/purchases-capacitor (recommended; handles receipt
//     validation server-side and gives cross-platform entitlements out of the box)
//   - @capgo/capacitor-purchases (simpler, no backend required)
//
// Whichever is installed, we read it off `window.Capacitor.Plugins` so there
// is no hardcoded import path for Vite to resolve.
async function loadPlugin() {
  try {
    if (typeof window === "undefined") return null;
    const plugins = window?.Capacitor?.Plugins;
    if (!plugins) return null;
    // Try both known plugin names in order of preference.
    return (
      plugins.InAppPurchases ||
      plugins.Purchases ||
      plugins.CdvPurchase ||
      null
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[iap] plugin lookup failed:", e);
    return null;
  }
}

export async function iapInit() {
  const IAP = await loadPlugin();
  if (!IAP) return { ok: false, reason: "plugin-missing" };
  try {
    // Register the product so queryProducts can return pricing info.
    await IAP.register?.({
      productIdentifier: PRODUCT_ID,
      productType: "PAID_SUBSCRIPTION",
    });
    // Listen for transaction events — receipts that come in after a purchase,
    // restore, or subscription renewal. The plugin API varies slightly by
    // version; we try common event names.
    const markActive = () => grantLocalEntitlement();
    IAP.addListener?.("purchaseCompleted", markActive);
    IAP.addListener?.("purchaseRestored", markActive);
    IAP.addListener?.("subscriptionRenewed", markActive);
    IAP.addListener?.("subscriptionExpired", () => clearLocalEntitlement());
    return { ok: true };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[iap] init failed:", e);
    return { ok: false, reason: "init-error", error: e };
  }
}

export async function iapGetPrice() {
  const IAP = await loadPlugin();
  if (!IAP) return null;
  try {
    const result = await IAP.queryProductDetails?.({
      productIdentifiers: [PRODUCT_ID],
    });
    const details = result?.products?.[0] || result?.[0] || null;
    return details?.price || details?.priceFormatted || null;
  } catch {
    return null;
  }
}

export async function iapBuy() {
  const IAP = await loadPlugin();
  if (!IAP) throw new Error("In-app purchase is not available right now.");
  // The plugin names the purchase method slightly differently across versions.
  const purchase =
    IAP.purchaseProduct || IAP.purchase || IAP.purchaseSubscription;
  if (!purchase) throw new Error("Purchase API not found.");
  const result = await purchase.call(IAP, {
    productIdentifier: PRODUCT_ID,
    productType: "PAID_SUBSCRIPTION",
  });
  // Success is usually signaled both by the returned promise AND the
  // purchaseCompleted listener. Be defensive and mark entitlement either way.
  if (result && (result.transactionState === "purchased" || result.state === "PURCHASED" || result.success)) {
    grantLocalEntitlement();
  }
  return result;
}

export async function iapRestore() {
  const IAP = await loadPlugin();
  if (!IAP) throw new Error("Restore is not available right now.");
  const restore = IAP.restorePurchases || IAP.restore;
  if (!restore) throw new Error("Restore API not found.");
  const result = await restore.call(IAP);
  // If any transaction comes back as purchased, grant locally. Listener also
  // fires so this is belt-and-braces.
  const txs = result?.transactions || result?.purchases || [];
  if (txs.some((t) => t.productIdentifier === PRODUCT_ID || t.productId === PRODUCT_ID)) {
    grantLocalEntitlement();
  }
  return result;
}
