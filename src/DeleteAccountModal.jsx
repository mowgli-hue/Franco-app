// Account deletion modal — required by App Store guideline 5.1.1(v).
//
// Flow:
//   1. "Are you sure?" explanation + typed confirmation ("DELETE")
//   2. Re-authenticate (Firebase requires recent login for sensitive ops)
//   3. Call user.delete()
//   4. Wipe local progress (localStorage) to avoid leaking back on reuse
//   5. Return to landing via onDeleted()
//
// Apple requires the flow to be self-serve — no customer service email/phone.
// We meet that: the whole deletion happens in-app.

import { useState } from "react";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  deleteUser,
} from "firebase/auth";
import { auth, friendlyAuthError } from "./firebase";

const LOCAL_KEYS_TO_WIPE = [
  "franco_progress",
  "franco_stats",
  "franco_achievements",
  "franco_companion",
  "franco_start_level",
  "franco_xp",
  "franco_streak",
  "franco_premium",
  "franco_onboarded",
];

export function DeleteAccountModal({ theme: T, onClose, onDeleted }) {
  const [step, setStep] = useState(1); // 1=warn, 2=confirm+password, 3=deleting
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const user = auth?.currentUser || null;
  const email = user?.email || "";

  const handleDelete = async (e) => {
    e?.preventDefault?.();
    setErr("");
    if (!user) {
      setErr("No signed-in user.");
      return;
    }
    if (!password) {
      setErr("Enter your password to confirm.");
      return;
    }
    setBusy(true);
    setStep(3);
    try {
      const cred = EmailAuthProvider.credential(email, password);
      await reauthenticateWithCredential(user, cred);
      // TODO(follow-up): if we add Firestore user docs later, delete those
      // here BEFORE deleteUser() — Firebase security rules only allow writes
      // by the owner, and after delete() the owner no longer exists.
      await deleteUser(user);

      // Wipe all local progress to avoid leaking into whatever account signs
      // in on this device next.
      for (const k of LOCAL_KEYS_TO_WIPE) {
        try {
          localStorage.removeItem(k);
        } catch {
          /* ignore — quota or private mode */
        }
      }
      onDeleted();
    } catch (e2) {
      setErr(friendlyAuthError(e2));
      setBusy(false);
      setStep(2);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(13,27,62,0.75)",
        backdropFilter: "blur(6px)",
        zIndex: 1001,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={busy ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 20,
          maxWidth: 420,
          width: "100%",
          overflow: "hidden",
          boxShadow: "0 24px 80px rgba(13,27,62,0.3)",
        }}
      >
        {step === 1 && (
          <>
            <div
              style={{
                background: "linear-gradient(135deg,#DC2626,#B91C1C)",
                padding: "24px 28px",
                color: "#fff",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
              <div
                style={{
                  fontFamily: "'Playfair Display',serif",
                  fontSize: 22,
                  fontWeight: 900,
                }}
              >
                Delete your account?
              </div>
            </div>
            <div style={{ padding: "20px 28px 8px" }}>
              <div
                style={{
                  fontSize: 14,
                  color: T.textMid,
                  lineHeight: 1.6,
                  marginBottom: 14,
                }}
              >
                This will permanently delete your Franco account and remove all
                associated data. <b>This action cannot be undone.</b>
              </div>
              <ul
                style={{
                  fontSize: 13,
                  color: T.textMid,
                  paddingLeft: 20,
                  lineHeight: 1.7,
                  marginBottom: 14,
                }}
              >
                <li>Your login, email, and password will be removed</li>
                <li>Your progress, XP, and streak will be wiped on this device</li>
                <li>You'll need to create a new account to use Franco again</li>
              </ul>
              <div
                style={{
                  fontSize: 13,
                  color: T.textSoft,
                  background: T.surface,
                  padding: "10px 12px",
                  borderRadius: 10,
                  marginBottom: 6,
                }}
              >
                Account: <b>{email}</b>
              </div>
            </div>
            <div
              style={{
                padding: "14px 28px 24px",
                display: "flex",
                gap: 10,
                flexDirection: "column",
              }}
            >
              <button
                onClick={() => setStep(2)}
                style={{
                  width: "100%",
                  padding: 14,
                  background: "#DC2626",
                  color: "#fff",
                  border: "none",
                  borderRadius: 12,
                  fontFamily: "'DM Sans',sans-serif",
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                Continue deletion
              </button>
              <button
                onClick={onClose}
                style={{
                  width: "100%",
                  padding: 12,
                  background: "transparent",
                  border: `1.5px solid ${T.border}`,
                  borderRadius: 12,
                  fontFamily: "'DM Sans',sans-serif",
                  fontWeight: 600,
                  fontSize: 14,
                  color: T.textMid,
                  cursor: "pointer",
                }}
              >
                Keep my account
              </button>
            </div>
          </>
        )}

        {(step === 2 || step === 3) && (
          <form onSubmit={handleDelete}>
            <div
              style={{
                background: "linear-gradient(135deg,#DC2626,#B91C1C)",
                padding: "24px 28px",
                color: "#fff",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontFamily: "'Playfair Display',serif",
                  fontSize: 20,
                  fontWeight: 900,
                }}
              >
                Confirm account deletion
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.85)",
                  marginTop: 4,
                }}
              >
                Enter your password to continue
              </div>
            </div>

            <div style={{ padding: "20px 28px 8px" }}>
              <label
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: T.textMid,
                  letterSpacing: 0.5,
                  display: "block",
                  marginBottom: 6,
                }}
              >
                TYPE "DELETE" TO CONFIRM
              </label>
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: `1.5px solid ${
                    confirm === "DELETE" ? "#DC2626" : T.border
                  }`,
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: 15,
                  background: "#fff",
                  outline: "none",
                  boxSizing: "border-box",
                  marginBottom: 14,
                }}
                placeholder="DELETE"
              />

              <label
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: T.textMid,
                  letterSpacing: 0.5,
                  display: "block",
                  marginBottom: 6,
                }}
              >
                PASSWORD
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: `1.5px solid ${T.border}`,
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: 15,
                  background: "#fff",
                  outline: "none",
                  boxSizing: "border-box",
                }}
                placeholder="Your current password"
                autoFocus
              />
            </div>

            {err && (
              <div
                style={{
                  margin: "8px 28px 0",
                  background: "#FEF2F2",
                  border: "1px solid #FECACA",
                  color: "#B91C1C",
                  padding: "10px 12px",
                  borderRadius: 10,
                  fontSize: 13,
                }}
              >
                {err}
              </div>
            )}

            <div
              style={{
                padding: "14px 28px 24px",
                display: "flex",
                gap: 10,
                flexDirection: "column",
              }}
            >
              <button
                type="submit"
                disabled={busy || confirm !== "DELETE" || !password}
                style={{
                  width: "100%",
                  padding: 14,
                  background:
                    busy || confirm !== "DELETE" || !password
                      ? "#D1D5DB"
                      : "#DC2626",
                  color: "#fff",
                  border: "none",
                  borderRadius: 12,
                  fontFamily: "'DM Sans',sans-serif",
                  fontWeight: 700,
                  fontSize: 14,
                  cursor:
                    busy || confirm !== "DELETE" || !password
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {busy ? "Deleting…" : "Permanently delete account"}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                style={{
                  width: "100%",
                  padding: 12,
                  background: "transparent",
                  border: `1.5px solid ${T.border}`,
                  borderRadius: 12,
                  fontFamily: "'DM Sans',sans-serif",
                  fontWeight: 600,
                  fontSize: 14,
                  color: T.textMid,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
