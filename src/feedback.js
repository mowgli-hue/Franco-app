// Sound + haptic feedback for Franco.
//
// Web Audio API for sounds (works on web + Capacitor WebView).
// navigator.vibrate for haptics on Android web.
// @capacitor/haptics for native iOS haptic taptic engine.
//
// Usage:
//   import { playCorrect, playWrong, playLevelUp, hapticTap, hapticSuccess } from "./feedback";
//   onCorrectAnswer: () => { playCorrect(); hapticSuccess(); }
//   onWrongAnswer:   () => { playWrong(); hapticTap(); }
//
// All functions are no-ops if the user has muted sounds (see SOUNDS_ENABLED flag).

const SOUNDS_KEY = "franco_sounds_on";
const HAPTICS_KEY = "franco_haptics_on";

const IS_IOS = (() => {
  try {
    return typeof window !== "undefined" &&
      window.Capacitor?.getPlatform?.() === "ios";
  } catch { return false; }
})();

// ─── User preferences ─────────────────────────────────────────────────────────
export function areSoundsEnabled() {
  try {
    const v = localStorage.getItem(SOUNDS_KEY);
    return v === null ? true : v === "1"; // default ON
  } catch { return true; }
}
export function areHapticsEnabled() {
  try {
    const v = localStorage.getItem(HAPTICS_KEY);
    return v === null ? true : v === "1";
  } catch { return true; }
}
export function setSoundsEnabled(on) {
  try { localStorage.setItem(SOUNDS_KEY, on ? "1" : "0"); } catch {}
}
export function setHapticsEnabled(on) {
  try { localStorage.setItem(HAPTICS_KEY, on ? "1" : "0"); } catch {}
}

// ─── Web Audio engine ─────────────────────────────────────────────────────────
// We construct a single shared AudioContext lazily on first use. iOS requires
// a user gesture before audio can play — we tolerate the failure silently.
let _ctx = null;
function ctx() {
  if (_ctx) return _ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _ctx = new AC();
    return _ctx;
  } catch { return null; }
}

// Play a quick sine-wave tone with a smooth attack/release envelope.
// `freq` in Hz, `duration` in seconds, `gain` 0-1.
function tone(freq, duration = 0.12, gain = 0.18, shape = "sine") {
  if (!areSoundsEnabled()) return;
  const ac = ctx();
  if (!ac) return;
  try {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = shape;
    osc.frequency.value = freq;
    osc.connect(g);
    g.connect(ac.destination);
    const now = ac.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + 0.01);    // 10ms attack
    g.gain.linearRampToValueAtTime(0, now + duration);   // smooth release
    osc.start(now);
    osc.stop(now + duration + 0.02);
  } catch { /* ignore */ }
}

// Play multiple tones in sequence (for chord-like flourishes).
function sequence(notes) {
  if (!areSoundsEnabled()) return;
  const ac = ctx();
  if (!ac) return;
  let t = 0;
  for (const n of notes) {
    setTimeout(() => tone(n.freq, n.dur || 0.1, n.gain || 0.15, n.shape || "sine"), t);
    t += (n.gap != null ? n.gap : (n.dur || 0.1) * 1000);
  }
}

// ─── Sound presets ────────────────────────────────────────────────────────────
// All sounds are intentionally short and not annoying.

// A single soft bell "ding" on a correct answer.
export function playCorrect() {
  tone(1046, 0.55, 0.17, "sine"); // C6 — clear bell strike
  tone(1568, 0.45, 0.05, "sine"); // G6 — subtle overtone for a bell shimmer
}

// Soft falling tone — "not quite", non-punishing.
export function playWrong() {
  sequence([
    { freq: 330, dur: 0.10, gain: 0.16, gap: 80 },
    { freq: 247, dur: 0.16, gain: 0.14 },
  ]);
}

// Triumphant 3-note flourish — for lesson completion, level-up, streak.
export function playLevelUp() {
  sequence([
    { freq: 523, dur: 0.10, gain: 0.18, gap: 90 },
    { freq: 659, dur: 0.10, gain: 0.18, gap: 90 },
    { freq: 880, dur: 0.18, gain: 0.22 },
  ]);
}

// Tiny tick — for button taps when extra feedback is wanted.
export function playTick() {
  tone(880, 0.04, 0.10, "triangle");
}

// ─── Haptics ──────────────────────────────────────────────────────────────────
// iOS native taptic engine via the Capacitor global Plugins object when
// available; fall back to navigator.vibrate (Android web). We avoid importing
// "@capacitor/haptics" so the web bundle builds without that dependency —
// the native iOS plugin is registered globally if it's installed in the
// Capacitor project, otherwise we fall through gracefully.
async function nativeHaptic(style) {
  if (!IS_IOS) return false;
  try {
    const H = window.Capacitor?.Plugins?.Haptics;
    if (!H) return false;
    if (style === "success") await H.notification({ type: "SUCCESS" });
    else if (style === "warning") await H.notification({ type: "WARNING" });
    else if (style === "error") await H.notification({ type: "ERROR" });
    else if (style === "heavy") await H.impact({ style: "HEAVY" });
    else if (style === "medium") await H.impact({ style: "MEDIUM" });
    else await H.impact({ style: "LIGHT" });
    return true;
  } catch { return false; }
}

function vibrate(pattern) {
  if (!areHapticsEnabled()) return;
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  } catch { /* ignore */ }
}

// A short tap — for button presses, correct answers.
export async function hapticTap() {
  if (!areHapticsEnabled()) return;
  const ok = await nativeHaptic("light");
  if (!ok) vibrate(10);
}

// A success buzz — for correct answers, lesson completion.
export async function hapticSuccess() {
  if (!areHapticsEnabled()) return;
  const ok = await nativeHaptic("success");
  if (!ok) vibrate([15, 60, 15]);
}

// A warning buzz — for wrong answers.
export async function hapticWarning() {
  if (!areHapticsEnabled()) return;
  const ok = await nativeHaptic("warning");
  if (!ok) vibrate([20, 40, 20]);
}

// A celebration burst — for level-ups, streaks.
export async function hapticCelebrate() {
  if (!areHapticsEnabled()) return;
  const ok = await nativeHaptic("success");
  if (!ok) vibrate([20, 50, 20, 50, 40]);
}

// ─── Convenience combo functions ──────────────────────────────────────────────
// One-line calls for common moments.
export function celebrateCorrect() { playCorrect(); hapticSuccess(); }
export function commiserateWrong() { playWrong(); hapticWarning(); }
export function celebrateLevelUp() { playLevelUp(); hapticCelebrate(); }

export default {
  playCorrect, playWrong, playLevelUp, playTick,
  hapticTap, hapticSuccess, hapticWarning, hapticCelebrate,
  celebrateCorrect, commiserateWrong, celebrateLevelUp,
  areSoundsEnabled, areHapticsEnabled, setSoundsEnabled, setHapticsEnabled,
};
