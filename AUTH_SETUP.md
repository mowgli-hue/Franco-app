# Franco Auth Setup Guide

## 1. Install Firebase

In your Vite project root, run:

```bash
npm install firebase
```

## 2. Create your .env file

Copy `.env.example` to `.env` in your project root:

```bash
cp .env.example .env
```

Then fill in your Firebase values. Get them from:
**Firebase Console → Project Settings → Your Apps → Web App → SDK setup and configuration**

```
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abc123
```

## 3. Enable Email/Password auth in Firebase

1. Go to **Firebase Console → Authentication → Sign-in method**
2. Enable **Email/Password**
3. Optionally enable **Email link (passwordless sign-in)**

## 4. Add your domain to Firebase authorized domains

1. Go to **Firebase Console → Authentication → Settings → Authorized domains**
2. Add `localhost` (already there by default)
3. Add your production domain (e.g. `franco.app` or your Vercel URL)

## 5. Replace FrancoApp.jsx

Drop the new `FrancoApp.jsx` into your `src/` folder, replacing the old one.

## How the auth flow works

```
App loads
  └─ Firebase initializing? → Show loading spinner
  └─ User logged in via Firebase? → Go straight to app
  └─ Not logged in?
       ├─ AuthLandingScreen  (landing page with features)
       │    ├─ "Start Training" → LoginScreen
       │    └─ "Try as Guest"  → App in guest mode (no account needed)
       ├─ LoginScreen
       │    ├─ Login with email + password
       │    ├─ "Register" → RegisterScreen
       │    └─ "Resend Verification" → resends verification email
       └─ RegisterScreen
            └─ Creates account → sends verification email → redirects to Login
```

## Guest mode

Users can click **"Try as Guest"** and use the full app without an account.
The TopBar shows a **"Sign in"** button when in guest mode so they can register later.

## Features from the old mobile app included

- Auth landing screen with animated avatar + feature cards
- Login with email/password validation + inline error messages
- Register with name, email, password, confirm password
- Email verification enforcement (blocks login until verified)
- Resend verification email button
- Password show/hide toggle
- Firebase error message mapping (human-readable errors)
- Sign out button in top navigation bar
- Guest mode with Sign in prompt
- User display name shown in top bar after login
