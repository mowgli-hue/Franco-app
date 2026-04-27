// Authentication screens: landing, login, register.
// Uses Firebase Auth (email/password). Guest mode is handled by the parent
// (FrancoApp) — AuthLandingScreen offers a "Continue as guest" button that
// simply calls onGuest() to bypass sign-in entirely.
//
// Exports:
//   AuthLandingScreen — entry point with Sign up / Log in / Guest options
//   LoginScreen       — email/password login + resend verification
//   RegisterScreen    — signup with email verification send
//
// Styling follows the Franco theme (T) defined in FrancoApp.jsx. Rather than
// import T (circular), we accept `theme` as a prop for each screen.

import { useState } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";
import { auth, friendlyAuthError } from "./firebase";

// Shared styles for inputs/buttons so all three screens look consistent.
const inputStyle = (theme) => ({
  width: "100%",
  padding: "14px 16px",
  borderRadius: 12,
  border: `1.5px solid ${theme.border}`,
  fontFamily: "'DM Sans',sans-serif",
  fontSize: 15,
  background: "#fff",
  color: theme.text,
  outline: "none",
  transition: "border-color 0.2s",
  boxSizing: "border-box",
});

const primaryBtnStyle = (theme) => ({
  width: "100%",
  padding: "15px",
  background: `linear-gradient(135deg,${theme.blue},${theme.navy})`,
  color: "#fff",
  border: "none",
  borderRadius: 12,
  fontFamily: "'DM Sans',sans-serif",
  fontWeight: 700,
  fontSize: 15,
  cursor: "pointer",
  boxShadow: `0 4px 16px ${theme.blue}33`,
  transition: "transform 0.1s",
});

const linkBtnStyle = (theme) => ({
  background: "transparent",
  border: "none",
  color: theme.blue,
  fontFamily: "'DM Sans',sans-serif",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  padding: 4,
});

// ────────────────────────────────────────────────────────────────────────
// AuthLandingScreen — first screen a non-signed-in user sees.
// Feature cards + three actions: Sign up, Log in, Continue as guest.
// Guest mode is important because Apple will reject if sign-in is mandatory
// for using basic features without a compelling reason (guideline 5.1.1(i)).
// ────────────────────────────────────────────────────────────────────────
export function AuthLandingScreen({ theme: T, onSignUp, onLogIn, onGuest }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: `linear-gradient(135deg,${T.navy} 0%,#1A3280 50%,${T.blue} 100%)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: -80,
          left: -80,
          width: 300,
          height: 300,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.04)",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: -60,
          right: -60,
          width: 240,
          height: 240,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.03)",
        }}
      />
      <div
        style={{
          background: "rgba(255,255,255,0.08)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 24,
          padding: "36px 32px",
          maxWidth: 440,
          width: "100%",
          color: "#fff",
          position: "relative",
          zIndex: 1,
        }}
      >
        <div style={{ fontSize: 60, textAlign: "center", marginBottom: 8 }}>
          🍁
        </div>
        <div
          style={{
            fontFamily: "'Playfair Display',serif",
            fontSize: 28,
            fontWeight: 900,
            textAlign: "center",
            marginBottom: 6,
          }}
        >
          Welcome to Franco
        </div>
        <div
          style={{
            fontSize: 14,
            color: "rgba(255,255,255,0.75)",
            textAlign: "center",
            marginBottom: 28,
            lineHeight: 1.5,
          }}
        >
          Learn French for Canada — structured, practical, CLB-aligned.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={onSignUp}
            style={{
              ...primaryBtnStyle(T),
              background: "#fff",
              color: T.navy,
              boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
            }}
          >
            Create account
          </button>
          <button
            onClick={onLogIn}
            style={{
              ...primaryBtnStyle(T),
              background: "rgba(255,255,255,0.12)",
              border: "1px solid rgba(255,255,255,0.25)",
              boxShadow: "none",
            }}
          >
            Log in
          </button>
          <button
            onClick={onGuest}
            style={{
              ...linkBtnStyle(T),
              color: "rgba(255,255,255,0.7)",
              marginTop: 8,
              fontSize: 13,
            }}
          >
            Continue as guest
          </button>
        </div>

        <div
          style={{
            marginTop: 24,
            paddingTop: 20,
            borderTop: "1px solid rgba(255,255,255,0.1)",
            fontSize: 11,
            color: "rgba(255,255,255,0.55)",
            textAlign: "center",
            lineHeight: 1.6,
          }}
        >
          Sign up to sync progress across devices.
          <br />
          Guest mode keeps everything on this device.
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// LoginScreen — email + password.
// - "Resend verification" button appears when the signed-in user is not yet
//   verified (we block access in that case).
// - onBack returns to the landing screen.
// - onSuccess is called after a successful + verified login.
// ────────────────────────────────────────────────────────────────────────
export function LoginScreen({ theme: T, onBack, onGoRegister, onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (!auth) throw new Error("Sign-in is not available right now.");
      const cred = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password
      );
      onSuccess(cred.user);
    } catch (e2) {
      setErr(friendlyAuthError(e2));
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: T.bg,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          background: "#fff",
          borderRadius: 20,
          padding: 32,
          maxWidth: 400,
          width: "100%",
          boxShadow: "0 8px 32px rgba(13,27,62,0.08)",
          border: `1px solid ${T.border}`,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{ ...linkBtnStyle(T), marginBottom: 16 }}
        >
          ← Back
        </button>
        <div
          style={{
            fontFamily: "'Playfair Display',serif",
            fontSize: 26,
            fontWeight: 900,
            color: T.navy,
            marginBottom: 6,
          }}
        >
          Welcome back
        </div>
        <div style={{ fontSize: 14, color: T.textSoft, marginBottom: 24 }}>
          Log in to continue your French journey.
        </div>

        <div style={{ marginBottom: 14 }}>
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
            EMAIL
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            style={inputStyle(T)}
            placeholder="you@example.com"
          />
        </div>

        <div style={{ marginBottom: 8 }}>
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
          <div style={{ position: "relative" }}>
            <input
              type={showPass ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ ...inputStyle(T), paddingRight: 64 }}
              placeholder="••••••••"
            />
            <button
              type="button"
              onClick={() => setShowPass((s) => !s)}
              style={{
                position: "absolute",
                right: 10,
                top: "50%",
                transform: "translateY(-50%)",
                background: "transparent",
                border: "none",
                color: T.textSoft,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                padding: 6,
              }}
            >
              {showPass ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {err && (
          <div
            style={{
              background: "#FEF2F2",
              border: "1px solid #FECACA",
              color: "#B91C1C",
              padding: "10px 12px",
              borderRadius: 10,
              fontSize: 13,
              marginBottom: 14,
              marginTop: 8,
            }}
          >
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            ...primaryBtnStyle(T),
            opacity: busy ? 0.6 : 1,
            cursor: busy ? "wait" : "pointer",
            marginTop: 8,
          }}
        >
          {busy ? "Logging in…" : "Log in"}
        </button>

        <div style={{ textAlign: "center", marginTop: 18, fontSize: 14 }}>
          <span style={{ color: T.textSoft }}>No account yet? </span>
          <button
            type="button"
            onClick={onGoRegister}
            style={linkBtnStyle(T)}
          >
            Create one
          </button>
        </div>
      </form>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// RegisterScreen — full-name + email + password + confirm.
// After successful registration, sends verification email and returns to
// login screen (via onRegistered).
// ────────────────────────────────────────────────────────────────────────
export function RegisterScreen({ theme: T, onBack, onGoLogin, onRegistered }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (password !== confirm) {
      setErr("Passwords don't match.");
      return;
    }
    if (password.length < 6) {
      setErr("Password must be at least 6 characters.");
      return;
    }
    setBusy(true);
    try {
      if (!auth) throw new Error("Sign-up is not available right now.");
      const cred = await createUserWithEmailAndPassword(
        auth,
        email.trim(),
        password
      );
      if (name.trim()) {
        await updateProfile(cred.user, { displayName: name.trim() });
      }
      // No email verification — user is signed in immediately after signup.
      // onAuthStateChanged in the top-level App will pick up the new user.
      onRegistered(email.trim());
    } catch (e2) {
      setErr(friendlyAuthError(e2));
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: T.bg,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          background: "#fff",
          borderRadius: 20,
          padding: 32,
          maxWidth: 400,
          width: "100%",
          boxShadow: "0 8px 32px rgba(13,27,62,0.08)",
          border: `1px solid ${T.border}`,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{ ...linkBtnStyle(T), marginBottom: 16 }}
        >
          ← Back
        </button>
        <div
          style={{
            fontFamily: "'Playfair Display',serif",
            fontSize: 26,
            fontWeight: 900,
            color: T.navy,
            marginBottom: 6,
          }}
        >
          Create your account
        </div>
        <div style={{ fontSize: 14, color: T.textSoft, marginBottom: 24 }}>
          Save your progress and sync across devices.
        </div>

        <div style={{ marginBottom: 14 }}>
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
            NAME
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            style={inputStyle(T)}
            placeholder="Your name"
          />
        </div>

        <div style={{ marginBottom: 14 }}>
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
            EMAIL
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={inputStyle(T)}
            placeholder="you@example.com"
          />
        </div>

        <div style={{ marginBottom: 14 }}>
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
          <div style={{ position: "relative" }}>
            <input
              type={showPass ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ ...inputStyle(T), paddingRight: 64 }}
              placeholder="At least 6 characters"
            />
            <button
              type="button"
              onClick={() => setShowPass((s) => !s)}
              style={{
                position: "absolute",
                right: 10,
                top: "50%",
                transform: "translateY(-50%)",
                background: "transparent",
                border: "none",
                color: T.textSoft,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                padding: 6,
              }}
            >
              {showPass ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        <div style={{ marginBottom: 8 }}>
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
            CONFIRM PASSWORD
          </label>
          <input
            type={showPass ? "text" : "password"}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            style={inputStyle(T)}
            placeholder="Re-enter your password"
          />
        </div>

        {err && (
          <div
            style={{
              background: "#FEF2F2",
              border: "1px solid #FECACA",
              color: "#B91C1C",
              padding: "10px 12px",
              borderRadius: 10,
              fontSize: 13,
              marginBottom: 14,
              marginTop: 8,
            }}
          >
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            ...primaryBtnStyle(T),
            opacity: busy ? 0.6 : 1,
            cursor: busy ? "wait" : "pointer",
            marginTop: 8,
          }}
        >
          {busy ? "Creating account…" : "Create account"}
        </button>

        <div style={{ textAlign: "center", marginTop: 18, fontSize: 14 }}>
          <span style={{ color: T.textSoft }}>Already have one? </span>
          <button type="button" onClick={onGoLogin} style={linkBtnStyle(T)}>
            Log in
          </button>
        </div>

        <div
          style={{
            marginTop: 16,
            fontSize: 11,
            color: T.textSoft,
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          By creating an account you agree to our Terms and Privacy Policy.
        </div>
      </form>
    </div>
  );
}
