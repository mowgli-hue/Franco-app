// Firebase initialization for Franco app.
// Uses Firebase web SDK directly. Wrapped in try/catch so init failures
// (missing env vars, network issues) don't crash the whole app — `auth` is
// just `null` in those cases and the app falls back to guest mode.

import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let _auth = null;
try {
  if (Object.values(firebaseConfig).every((v) => v)) {
    const app = initializeApp(firebaseConfig);
    _auth = getAuth(app);
  } else {
    // eslint-disable-next-line no-console
    console.warn("[firebase] missing env vars, auth disabled");
  }
} catch (e) {
  // eslint-disable-next-line no-console
  console.error("[firebase] init failed:", e);
}
export const auth = _auth;

// Map Firebase error codes to user-friendly messages.
export function friendlyAuthError(err) {
  const code = err?.code || "";
  const map = {
    "auth/invalid-email": "That email address looks invalid.",
    "auth/user-disabled": "This account has been disabled. Contact support.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password. Try again.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/email-already-in-use":
      "An account with that email already exists. Try logging in.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/too-many-requests":
      "Too many attempts. Please wait a minute and try again.",
    "auth/network-request-failed":
      "Network error. Check your connection and try again.",
    "auth/requires-recent-login":
      "For security, please sign in again to complete this action.",
    "auth/popup-closed-by-user": "Sign-in cancelled.",
  };
  return map[code] || err?.message || "Something went wrong. Please try again.";
}
