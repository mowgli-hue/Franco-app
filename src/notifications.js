// ─── DAILY STUDY REMINDERS (on-device local notifications) ─────────────────────
// Brings learners back to keep their streak alive. Uses @capacitor/local-
// notifications, which fire entirely ON THE DEVICE — no server, no Apple push
// certificate, no backend required. (That's the difference from "remote push":
// remote push needs an APNs key + a sending backend; local reminders don't.)
//
// ONE-TIME SETUP (on your machine):
//   1. npm i @capacitor/local-notifications
//   2. npx cap sync ios   → rebuild + submit once so the plugin is in the binary
// No Apple Developer certificate needed for local notifications.
//
// The dynamic import is @vite-ignore'd so the web build never resolves the
// native module — it loads only on device, after you install it.

const IS_IOS = (() => {
  try {
    return typeof window !== "undefined" &&
      window.Capacitor?.getPlatform?.() === "ios";
  } catch { return false; }
})();

const REMINDER_ID = 4201; // stable id so re-scheduling replaces, not duplicates

async function loadPlugin(){
  const mod = "@capacitor/local-notifications";
  const { LocalNotifications } = await import(/* @vite-ignore */ mod);
  return LocalNotifications;
}

// Ask permission and schedule a daily reminder at `hour` (24h, default 7pm).
// Returns {ok, reason?}. Call this from a user action (e.g. a toggle), never
// silently on launch — iOS only shows the permission prompt once.
export async function enableDailyReminder(hour = 19, minute = 0){
  if(!IS_IOS) return { ok:false, reason:"not-ios" };
  try{
    const LN = await loadPlugin();
    const perm = await LN.requestPermissions();
    if(perm?.display !== "granted") return { ok:false, reason:"denied" };
    await LN.schedule({
      notifications: [{
        id: REMINDER_ID,
        title: "Time for French! 🍁",
        body: "A few minutes today keeps your streak alive. On y va !",
        schedule: { on: { hour, minute }, allowWhileIdle: true }, // repeats daily
      }]
    });
    try{ localStorage.setItem("franco_reminder_on", JSON.stringify({hour,minute})); }catch{}
    return { ok:true };
  }catch(e){
    // eslint-disable-next-line no-console
    console.warn("[notifications] enable failed:", e?.message);
    return { ok:false, reason:"error" };
  }
}

export async function disableDailyReminder(){
  if(!IS_IOS) return { ok:true };
  try{
    const LN = await loadPlugin();
    await LN.cancel({ notifications: [{ id: REMINDER_ID }] });
    try{ localStorage.removeItem("franco_reminder_on"); }catch{}
    return { ok:true };
  }catch(e){
    // eslint-disable-next-line no-console
    console.warn("[notifications] disable failed:", e?.message);
    return { ok:false };
  }
}

// Is the reminder currently enabled (per our local flag)?
export function reminderEnabled(){
  try{ return !!localStorage.getItem("franco_reminder_on"); }catch{ return false; }
}
