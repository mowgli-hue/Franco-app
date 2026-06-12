// ─── OVER-THE-AIR LIVE UPDATES (Capgo) ────────────────────────────────────────
// Lets us ship JavaScript / CSS / content fixes to the iOS app within minutes,
// WITHOUT waiting for App Store review. Apple permits this as long as we only
// change web assets (not the app's native code or core purpose) — which is
// exactly what our lesson/UI fixes are.
//
// HOW IT WORKS
//   • Capgo's native plugin downloads new web bundles in the background and
//     swaps them in on the next launch (autoUpdate mode, configured in
//     capacitor.config.ts under plugins.CapacitorUpdater).
//   • We MUST call notifyAppReady() once at startup, otherwise the plugin
//     assumes the new bundle crashed and rolls back to the previous one.
//
// ONE-TIME SETUP (you do this on your machine — see the checklist I gave you):
//   1. npm i @capgo/capacitor-updater
//   2. npx @capgo/cli login <your-key>     (free account at capgo.app)
//   3. npx @capgo/cli app add app.franco.www
//   4. npx cap sync ios   → rebuild + submit ONCE so the plugin is in the binary
// AFTER THAT, every future web fix ships live with:
//   npm run build && npx @capgo/cli bundle upload --channel production
//
// The dynamic import is marked @vite-ignore so the web build never tries to
// resolve the native module — it only loads on the device, after you install it.

const IS_IOS = (() => {
  try {
    return typeof window !== "undefined" &&
      window.Capacitor?.getPlatform?.() === "ios";
  } catch { return false; }
})();

let _started = false;

// Call once at app startup. Safe no-op on web and if the plugin isn't installed
// yet (so the app keeps working before the one-time native rebuild).
export async function liveUpdateInit(){
  if(!IS_IOS || _started) return { ok:true, skipped:true };
  _started = true;
  try{
    const mod = "@capgo/capacitor-updater";
    const { CapacitorUpdater } = await import(/* @vite-ignore */ mod);
    // Tell Capgo the freshly-applied bundle booted fine — prevents auto-rollback.
    await CapacitorUpdater.notifyAppReady();
    return { ok:true };
  }catch(e){
    // Plugin not installed yet, or load failed — fail silent; the app runs the
    // bundle baked into the binary.
    // eslint-disable-next-line no-console
    console.warn("[liveupdate] not active:", e?.message);
    return { ok:false, reason:"plugin-missing" };
  }
}
