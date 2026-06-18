import { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } from "react";
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, signOut, reload, updateProfile, deleteUser, EmailAuthProvider, reauthenticateWithCredential } from "firebase/auth";
// Detect iOS Capacitor wrapper. Used to bypass external Stripe paywall on iOS
// (App Store guideline 3.1.1) and to determine which UI affordances to show.
const IS_IOS_APP = (() => {
  try {
    return typeof window !== "undefined" &&
      window.Capacitor?.getPlatform?.() === "ios";
  } catch { return false; }
})();
import { getFirestore, doc, setDoc, getDoc, onSnapshot, deleteDoc, collection, addDoc, getDocs, updateDoc, query, where } from "firebase/firestore";
import { buildSophieSystemPrompt, sophieOpener } from "./sophie";
import { getLessonVideo, youTubeEmbedUrl } from "./lessonVideos";
import { celebrateCorrect, commiserateWrong, celebrateLevelUp } from "./feedback";


// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE AUTH SETUP
// ─────────────────────────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            (import.meta.env.VITE_FIREBASE_API_KEY            || "").trim(),
  authDomain:        (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN        || "").trim(),
  projectId:         (import.meta.env.VITE_FIREBASE_PROJECT_ID         || "").trim(),
  storageBucket:     (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET     || "").trim(),
  messagingSenderId: (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID|| "").trim(),
  appId:             (import.meta.env.VITE_FIREBASE_APP_ID             || "").trim(),
};

const hasFirebaseConfig = Object.values(FIREBASE_CONFIG).every(v=>v.trim().length>0);
let _firebaseApp = null;
let _firebaseAuth = null;
let _firebaseDb = null;
if(hasFirebaseConfig){
  try{
    _firebaseApp = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
    _firebaseAuth = getAuth(_firebaseApp);
    _firebaseDb = getFirestore(_firebaseApp);
  }catch(e){ console.error("[firebase] init failed",e); }
}

// ─── ANALYTICS ────────────────────────────────────────────────────────────────
// Find where learners drop off (esp. the B1 churn concern). Best-effort & never
// throws. Three sinks: console, a capped local log (localStorage "franco_events",
// last 200), and a Firestore "events" collection when available.
// To view aggregate data: Firebase console → Firestore → "events". This needs a
// security rule allowing creates on /events, e.g.:
//   match /events/{id} { allow create: if true; allow read: if false; }
function _anonId(){
  try{
    let id = localStorage.getItem("franco_anon_id");
    if(!id){ id = "a_"+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem("franco_anon_id", id); }
    return id;
  }catch{ return "anon"; }
}
function logEvent(name, props={}){
  let track=null; try{ track=localStorage.getItem("franco_track"); }catch{}
  const evt = { name, ...props, ts: Date.now(), anon: _anonId(), track };
  try{ console.log("[event]", name, props); }catch{}
  try{
    const log = JSON.parse(localStorage.getItem("franco_events")||"[]");
    log.push(evt);
    localStorage.setItem("franco_events", JSON.stringify(log.slice(-200)));
  }catch{}
  try{ if(_firebaseDb) addDoc(collection(_firebaseDb,"events"), evt).catch(()=>{}); }catch{}
}

// ─── FIRESTORE USER DATA ──────────────────────────────────────────────────────
async function saveUserData(userId, data){
  if(!_firebaseDb||!userId) return;
  try{
    await setDoc(doc(_firebaseDb,"users",userId), data, {merge:true});
  }catch(e){ console.warn("Firestore save failed",e); }
}

async function loadUserData(userId){
  if(!_firebaseDb||!userId) return null;
  try{
    const snap = await getDoc(doc(_firebaseDb,"users",userId));
    return snap.exists()?snap.data():null;
  }catch(e){ console.warn("Firestore load failed",e); return null; }
}

// ─── SPACED REPETITION ENGINE ─────────────────────────────────────────────────
// SM-2 algorithm: calculates next review date based on performance
function calcNextReview(prevInterval, prevEF, quality){
  // quality: 0-5 (0=blackout, 5=perfect)
  const ef = Math.max(1.3, prevEF + 0.1 - (5-quality)*(0.08+(5-quality)*0.02));
  let interval;
  if(quality<3){ interval=1; }
  else if(!prevInterval){ interval=1; }
  else if(prevInterval===1){ interval=6; }
  else{ interval=Math.round(prevInterval*ef); }
  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate()+interval);
  return {interval, ef, nextDate:nextDate.toISOString(), quality};
}

function isDueForReview(reviewData){
  if(!reviewData?.nextDate) return false;
  return new Date(reviewData.nextDate) <= new Date();
}

// Read the locally-persisted SRS schedule and return the lesson IDs that are due
// for review today (and that the learner has actually completed). Works for
// guests / the iOS app, where the review schedule lives in localStorage.
function getDueReviewIds(progress, cloudReviews){
  let reviews=cloudReviews;
  if(!reviews || !Object.keys(reviews).length){
    try{ reviews=JSON.parse(localStorage.getItem("franco_reviews")||"{}"); }catch{ reviews={}; }
  }
  if(!reviews) return [];
  return Object.keys(reviews).filter(id => progress?.[id] && isDueForReview(reviews[id]));
}

function mapAuthError(error){
  const code = error?.code || "";
  switch(code){
    case "auth/invalid-email":          return "Please enter a valid email address.";
    case "auth/invalid-credential":
    case "auth/wrong-password":         return "Invalid email or password.";
    case "auth/user-not-found":         return "No account found with this email.";
    case "auth/email-not-verified":     return "Please verify your email before logging in. A new verification email has been sent.";
    case "auth/email-already-verified": return "Email is already verified. You can login now.";
    case "auth/email-already-in-use":   return "This email is already registered.";
    case "auth/weak-password":          return "Password must be at least 6 characters.";
    case "auth/too-many-requests":      return "Too many attempts. Please try again later.";
    case "auth/network-request-failed": return "Network error. Check your connection.";
    case "auth/operation-not-allowed":  return "Email/password sign-in is disabled. Check Firebase console.";
    case "auth/unauthorized-domain":    return "This domain is not authorized in Firebase Auth. Add it in Firebase Console → Authentication → Settings → Authorized domains.";
    default:
      if(error?.message) return `Authentication failed: ${error.message}`;
      return "Authentication failed. Check your Firebase configuration.";
  }
}

// ─── AUTH CONTEXT ─────────────────────────────────────────────────────────────
const AuthContext = createContext(null);

function AuthProvider({children}){
  const[user,setUser]=useState(undefined);
  const[initializing,setInitializing]=useState(true);
  const[cloudProgress,setCloudProgress]=useState(null);
  const[cloudStreak,setCloudStreak]=useState(0);
  const[cloudXP,setCloudXP]=useState(0);
  const[reviewSchedule,setReviewSchedule]=useState({});

  useEffect(()=>{
    // On iOS we ship guest-only and don't initialize Firebase auth — avoids
    // the Capacitor + WebView hang where onAuthStateChanged never fires.
    if(IS_IOS_APP){ setUser(null); setInitializing(false); return; }
    // Safety: if Firebase doesn't resolve in 4s, unblock UI anyway.
    const safety = setTimeout(()=>setInitializing(false), 4000);
    if(!_firebaseAuth){ clearTimeout(safety); setInitializing(false); return; }
    const unsub = onAuthStateChanged(_firebaseAuth, async u=>{
      clearTimeout(safety);
      setUser(u);
      setInitializing(false);
      if(u){
        // Check backend for premium status
        checkBackendPremium(u.uid).then(isPro=>{
          if(isPro && !isPremiumUnlocked()) window.location.reload();
        });
      }
      if(u && _firebaseDb){
        // Load cloud data on login
        const data = await loadUserData(u.uid);
        if(data){
          if(data.progress) setCloudProgress(data.progress);
          if(data.streak) setCloudStreak(data.streak);
          if(data.xp) setCloudXP(data.xp);
          if(data.reviewSchedule) setReviewSchedule(data.reviewSchedule);
        }
      }
    });
    return unsub;
  },[]);

  const value = useMemo(()=>({
    user,
    initializing,
    firebaseReady: !!_firebaseAuth,
    cloudProgress, cloudStreak, cloudXP, reviewSchedule,
    async saveProgress(progress, xp, streak, reviews){
      if(!user||!_firebaseDb) return;
      const today=new Date().toISOString().split("T")[0];
      await saveUserData(user.uid,{
        progress, xp, streak,
        reviewSchedule:reviews||{},
        lastActive:today,
        updatedAt:new Date().toISOString()
      });
      setCloudProgress(progress);
      setCloudXP(xp);
      setCloudStreak(streak);
      if(reviews) setReviewSchedule(reviews);
    },
    async updateReview(lessonId, quality){
      if(!user||!_firebaseDb) return;
      const prev=reviewSchedule[lessonId]||{};
      const next=calcNextReview(prev.interval||0, prev.ef||2.5, quality);
      const updated={...reviewSchedule,[lessonId]:next};
      setReviewSchedule(updated);
      await saveUserData(user.uid,{reviewSchedule:updated});
      return next;
    },

    async login(email, password){
      if(!_firebaseAuth) throw Object.assign(new Error("Firebase not configured.")  ,{code:"auth/no-config"});
      const cred = await signInWithEmailAndPassword(_firebaseAuth, email, password);
      await reload(cred.user);
      if(!cred.user.emailVerified){
        try{ await sendEmailVerification(cred.user); }catch{}
        await signOut(_firebaseAuth);
        throw Object.assign(new Error("Email not verified"), {code:"auth/email-not-verified"});
      }
    },

    async register(name, email, password){
      if(!_firebaseAuth) throw Object.assign(new Error("Firebase not configured."),{code:"auth/no-config"});
      const cred = await createUserWithEmailAndPassword(_firebaseAuth, email, password);
      if(name.trim()) await updateProfile(cred.user,{displayName:name.trim()});
      try{ await sendEmailVerification(cred.user); }catch{}
      await signOut(_firebaseAuth);
    },

    async resendVerification(email, password){
      if(!_firebaseAuth) throw Object.assign(new Error("Firebase not configured."),{code:"auth/no-config"});
      const cred = await signInWithEmailAndPassword(_firebaseAuth, email, password);
      await reload(cred.user);
      if(cred.user.emailVerified){
        await signOut(_firebaseAuth);
        throw Object.assign(new Error("Already verified"),{code:"auth/email-already-verified"});
      }
      await sendEmailVerification(cred.user);
      await signOut(_firebaseAuth);
    },

    async logout(){
      if(_firebaseAuth) await signOut(_firebaseAuth);
    },

    // Account deletion — required by App Store guideline 5.1.1(v).
    // Re-authenticates with the provided password (Firebase requires recent
    // login for sensitive ops), deletes the Firestore user doc if present,
    // then deletes the Firebase Auth user, and finally wipes local progress.
    async deleteAccount(password){
      if(!_firebaseAuth) throw Object.assign(new Error("Firebase not configured."),{code:"auth/no-config"});
      const u = _firebaseAuth.currentUser;
      if(!u) throw Object.assign(new Error("No signed-in user."),{code:"auth/no-user"});
      // Step 1: re-authenticate so deleteUser() doesn't fail with auth/requires-recent-login.
      const cred = EmailAuthProvider.credential(u.email||"", password||"");
      await reauthenticateWithCredential(u, cred);
      // Step 2: delete Firestore user doc (best-effort — user data won't leak even if this fails).
      if(_firebaseDb){
        try { await deleteDoc(doc(_firebaseDb, "users", u.uid)); } catch(e) { console.warn("[deleteAccount] firestore cleanup failed", e); }
      }
      // Step 3: delete the Firebase Auth user.
      await deleteUser(u);
      // Step 4: wipe local progress so it doesn't leak to whoever signs in next.
      try {
        ["franco_progress","franco_companion","franco_level","franco_premium","franco_screen","franco_guest","franco_auth_screen"].forEach(k=>localStorage.removeItem(k));
      } catch {}
    }
  }),[user, initializing]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth(){
  const ctx = useContext(AuthContext);
  if(!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

// ─── AUTH LANDING SCREEN ─────────────────────────────────────────────────────
function AuthLandingScreen({onNavigate, onGuest}){
  const[hovered,setHovered]=useState(null);
  const features=[
    {id:"speaking", icon:"🗣️", text:"AI speaking practice"},
    {id:"clb",      icon:"🎯", text:"CLB + TEF aligned sessions"},
    {id:"canada",   icon:"🍁", text:"Canadian context scenarios"},
    {id:"ai",       icon:"🤖", text:"Adaptive feedback and coaching"},
  ];
  return(
    <div style={{minHeight:"100vh",background:"#F7FAFF",display:"flex",flexDirection:"column",alignItems:"center",padding:"40px 24px",gap:40,overflowY:"auto"}}>
      {/* Hero */}
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:16,maxWidth:560,width:"100%",textAlign:"center",animation:"slideUp 0.5s ease"}}>
        {/* Avatar */}
        <div style={{width:102,height:102,borderRadius:"50%",background:"#EAF2FF",border:"1.5px solid #BFDBFE",display:"flex",alignItems:"center",justifyContent:"center",fontSize:46,position:"relative",animation:"float 3s ease-in-out infinite",boxShadow:"0 8px 32px rgba(26,86,219,0.12)"}}>
          👩‍🏫
          <span style={{position:"absolute",top:-10,right:-8,fontSize:22,animation:"float 2.5s ease-in-out infinite 0.5s"}}>👋</span>
        </div>
        {/* Speech bubble */}
        <div style={{border:"1.5px solid #BFDBFE",borderRadius:14,background:"#fff",padding:"10px 18px",maxWidth:400,boxShadow:"0 2px 8px rgba(0,0,0,0.04)"}}>
          <span style={{fontSize:13,color:"#0D1B3E",fontStyle:"italic"}}>Bonjour! I'm your AI coach for Canadian French training.</span>
        </div>
        <div style={{fontFamily:"Georgia,serif",fontSize:30,fontWeight:900,color:"#0B1220",lineHeight:1.2,marginTop:8}}>French Training for Canada</div>
        <div style={{fontSize:15,color:"#475569",lineHeight:1.65}}>Structured daily sessions to improve CLB performance for immigration goals.</div>

        {/* CTA buttons */}
        <button onClick={()=>onNavigate("login")}
          style={{marginTop:16,width:"100%",maxWidth:340,padding:"15px 32px",background:"#1A56DB",color:"#fff",border:"none",borderRadius:14,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:16,cursor:"pointer",boxShadow:"0 4px 20px rgba(26,86,219,0.3)",transition:"all 0.2s"}}
          onMouseEnter={e=>e.currentTarget.style.background="#1547c0"}
          onMouseLeave={e=>e.currentTarget.style.background="#1A56DB"}>
          Start Training
        </button>

        <button onClick={onGuest}
          style={{marginTop:8,padding:"11px 28px",background:"#EFF6FF",color:"#1A56DB",border:"1.5px solid #BFDBFE",borderRadius:999,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",transition:"all 0.2s"}}
          onMouseEnter={e=>{e.currentTarget.style.background="#E2ECFF";}}
          onMouseLeave={e=>{e.currentTarget.style.background="#EFF6FF";}}>
          Try as Guest
        </button>

        <span onClick={()=>onNavigate("login")} style={{fontSize:13,color:"#64748B",cursor:"pointer",marginTop:4,textDecoration:"underline"}}>Already registered? Sign in</span>
        <span style={{fontSize:12,color:"#94A3B8",marginTop:4}}>Used by learners preparing for Canadian immigration pathways</span>
      </div>

      {/* Feature cards */}
      <div style={{width:"100%",maxWidth:560}}>
        {features.map(f=>(
          <div key={f.id}
            onMouseEnter={()=>setHovered(f.id)} onMouseLeave={()=>setHovered(null)}
            style={{background:hovered===f.id?"#F6FAFF":"#fff",border:`1.5px solid ${hovered===f.id?"#BFDBFE":"#D7E3F8"}`,borderRadius:14,padding:"16px 20px",display:"flex",alignItems:"center",gap:14,marginBottom:10,transition:"all 0.2s",cursor:"default"}}>
            <span style={{fontSize:20}}>{f.icon}</span>
            <span style={{fontSize:14,fontWeight:600,color:"#0D1B3E"}}>{f.text}</span>
          </div>
        ))}
        <div style={{textAlign:"center",marginTop:20}}>
          <div style={{fontSize:13,fontWeight:600,color:"#475569"}}>🇨🇦 Powered by Newton Immigration</div>
          <div style={{fontSize:12,color:"#94A3B8",marginTop:4}}>Built by licensed Canadian immigration professionals.</div>
        </div>
      </div>
    </div>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({onNavigate, prefillEmail="", notice=""}){
  const{login,resendVerification,firebaseReady}=useAuth();
  const[email,setEmail]=useState(prefillEmail);
  const[password,setPassword]=useState("");
  const[errors,setErrors]=useState({});
  const[loading,setLoading]=useState(false);
  const[resending,setResending]=useState(false);
  const[infoMsg,setInfoMsg]=useState(notice||"");

  const canSubmit = email.trim()&&password.trim()&&!loading;

  const validate=()=>{
    const e={};
    if(!email.trim()) e.email="Email is required";
    else if(!/^\S+@\S+\.\S+$/.test(email.trim())) e.email="Enter a valid email address";
    if(!password.trim()) e.password="Password is required";
    setErrors(e);
    return Object.keys(e).length===0;
  };

  const handleLogin=async()=>{
    if(!validate()) return;
    try{
      setLoading(true); setInfoMsg("");
      await login(email.trim(), password);
    }catch(err){
      setErrors(p=>({...p,submit:mapAuthError(err)}));
    }finally{ setLoading(false); }
  };

  const handleResend=async()=>{
    if(!validate()) return;
    try{
      setResending(true); setInfoMsg("");
      await resendVerification(email.trim(), password);
      setInfoMsg("Verification email sent! Please check inbox/spam, then login.");
    }catch(err){
      setErrors(p=>({...p,submit:mapAuthError(err)}));
    }finally{ setResending(false); }
  };

  return(
    <div style={{minHeight:"100vh",background:"#F7FAFF",display:"flex",alignItems:"center",justifyContent:"center",padding:"32px 24px"}}>
      <div style={{width:"100%",maxWidth:440,animation:"slideUp 0.4s ease"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontFamily:"Georgia,serif",fontSize:26,fontWeight:700,color:"#0D1B3E"}}>Welcome back</div>
          <div style={{fontSize:14,color:"#475569",marginTop:6}}>Sign in to continue your structured French training.</div>
        </div>

        {!firebaseReady&&(
          <div style={{background:"#FEF3C7",border:"1.5px solid #FCD34D",borderRadius:12,padding:"12px 16px",marginBottom:16,fontSize:13,color:"#92400E"}}>
            ⚠️ Firebase is not configured. Add your <code>.env</code> keys to enable login. You can still <span onClick={()=>onNavigate("guest")} style={{fontWeight:700,cursor:"pointer",textDecoration:"underline"}}>continue as guest</span>.
          </div>
        )}

        <div style={{background:"#fff",borderRadius:20,padding:"28px 28px",boxShadow:"0 2px 8px rgba(0,0,0,0.04),0 12px 32px rgba(13,27,62,0.08)"}}>
          <AuthInput label="Email" type="email" value={email} onChange={v=>{setEmail(v);setErrors(p=>({...p,email:undefined,submit:undefined}));}} placeholder="you@example.com" error={errors.email}/>
          <AuthInput label="Password" type="password" value={password} onChange={v=>{setPassword(v);setErrors(p=>({...p,password:undefined,submit:undefined}));}} placeholder="Enter password" error={errors.password}/>

          {infoMsg&&<div style={{fontSize:13,color:"#059669",background:"#D1FAE5",borderRadius:8,padding:"9px 12px",marginBottom:14}}>{infoMsg}</div>}
          {errors.submit&&<div style={{fontSize:13,color:"#991B1B",background:"#FEE2E2",borderRadius:8,padding:"9px 12px",marginBottom:14}}>{errors.submit}</div>}

          <div style={{display:"flex",flexDirection:"column",gap:10,marginTop:8}}>
            <AuthBtn label="Login" onClick={handleLogin} disabled={!canSubmit} loading={loading} primary/>
            <AuthBtn label="Register" onClick={()=>onNavigate("register")} variant="outline" disabled={loading}/>
            <AuthBtn label="Resend Verification Email" onClick={handleResend} variant="text" disabled={loading||resending} loading={resending}/>
            <AuthBtn label="← Back" onClick={()=>onNavigate("landing")} variant="text" disabled={loading}/>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── REGISTER SCREEN ──────────────────────────────────────────────────────────
function RegisterScreen({onNavigate}){
  const{register,firebaseReady}=useAuth();
  const[name,setName]=useState("");
  const[email,setEmail]=useState("");
  const[password,setPassword]=useState("");
  const[confirm,setConfirm]=useState("");
  const[errors,setErrors]=useState({});
  const[loading,setLoading]=useState(false);

  const canSubmit = name.trim()&&email.trim()&&password.trim()&&confirm.trim()&&!loading;

  const handleRegister=async()=>{
    const e={};
    if(!name.trim()) e.name="Full name is required";
    if(!email.trim()) e.email="Email is required";
    else if(!/^\S+@\S+\.\S+$/.test(email.trim())) e.email="Enter a valid email address";
    if(!password.trim()) e.password="Password is required";
    else if(password.length<6) e.password="Password must be at least 6 characters";
    if(!confirm.trim()) e.confirm="Please confirm your password";
    else if(confirm!==password) e.confirm="Passwords do not match";
    setErrors(e);
    if(Object.keys(e).length>0) return;

    try{
      setLoading(true);
      await register(name, email.trim(), password);
      onNavigate("login", {prefillEmail:email.trim(), notice:"Verification email sent! Please verify your email, then login."});
    }catch(err){
      setErrors(p=>({...p,submit:mapAuthError(err)}));
    }finally{ setLoading(false); }
  };

  return(
    <div style={{minHeight:"100vh",background:"#F7FAFF",display:"flex",alignItems:"center",justifyContent:"center",padding:"32px 24px"}}>
      <div style={{width:"100%",maxWidth:440,animation:"slideUp 0.4s ease"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontFamily:"Georgia,serif",fontSize:26,fontWeight:700,color:"#0D1B3E"}}>Create your account</div>
          <div style={{fontSize:14,color:"#475569",marginTop:6}}>Start your AI-guided French training for Canada.</div>
        </div>

        {!firebaseReady&&(
          <div style={{background:"#FEF3C7",border:"1.5px solid #FCD34D",borderRadius:12,padding:"12px 16px",marginBottom:16,fontSize:13,color:"#92400E"}}>
            ⚠️ Firebase is not configured. Add your <code>.env</code> keys to enable registration.
          </div>
        )}

        <div style={{background:"#fff",borderRadius:20,padding:"28px 28px",boxShadow:"0 2px 8px rgba(0,0,0,0.04),0 12px 32px rgba(13,27,62,0.08)"}}>
          <AuthInput label="Full name" value={name} onChange={v=>{setName(v);setErrors(p=>({...p,name:undefined,submit:undefined}));}} placeholder="Your full name" error={errors.name}/>
          <AuthInput label="Email" type="email" value={email} onChange={v=>{setEmail(v);setErrors(p=>({...p,email:undefined,submit:undefined}));}} placeholder="you@example.com" error={errors.email}/>
          <AuthInput label="Password" type="password" value={password} onChange={v=>{setPassword(v);setErrors(p=>({...p,password:undefined,submit:undefined}));}} placeholder="Create a password (min. 6 chars)" error={errors.password}/>
          <AuthInput label="Confirm password" type="password" value={confirm} onChange={v=>{setConfirm(v);setErrors(p=>({...p,confirm:undefined,submit:undefined}));}} placeholder="Re-enter your password" error={errors.confirm}/>

          {errors.submit&&<div style={{fontSize:13,color:"#991B1B",background:"#FEE2E2",borderRadius:8,padding:"9px 12px",marginBottom:14}}>{errors.submit}</div>}

          <div style={{display:"flex",flexDirection:"column",gap:10,marginTop:8}}>
            <AuthBtn label="Create Account" onClick={handleRegister} disabled={!canSubmit} loading={loading} primary/>
            <AuthBtn label="Already have an account? Login" onClick={()=>onNavigate("login")} variant="outline" disabled={loading}/>
            <AuthBtn label="← Back" onClick={()=>onNavigate("landing")} variant="text" disabled={loading}/>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── AUTH SHARED COMPONENTS ───────────────────────────────────────────────────
function AuthInput({label,type="text",value,onChange,placeholder,error}){
  const[show,setShow]=useState(false);
  const isPass=type==="password";
  return(
    <div style={{marginBottom:16}}>
      <label style={{display:"block",fontSize:13,fontWeight:700,color:"#0D1B3E",marginBottom:6}}>{label}</label>
      <div style={{position:"relative"}}>
        <input type={isPass&&show?"text":type} value={value}
          onChange={e=>onChange(e.target.value)}
          placeholder={placeholder}
          style={{width:"100%",padding:"12px 14px",paddingRight:isPass?44:14,borderRadius:10,border:`1.5px solid ${error?"#EF4444":"#E2E8F0"}`,fontFamily:"system-ui,-apple-system,sans-serif",fontSize:14,color:"#0D1B3E",outline:"none",background:"#fff",boxSizing:"border-box",transition:"border-color 0.2s"}}
          onFocus={e=>e.target.style.borderColor="#1A56DB"}
          onBlur={e=>e.target.style.borderColor=error?"#EF4444":"#E2E8F0"}
        />
        {isPass&&<button type="button" onClick={()=>setShow(s=>!s)}
          style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",fontSize:16,color:"#94A3B8",padding:0}}>
          {show?"🙈":"👁️"}
        </button>}
      </div>
      {error&&<div style={{fontSize:12,color:"#EF4444",marginTop:4}}>{error}</div>}
    </div>
  );
}

function AuthBtn({label,onClick,disabled,loading,primary,variant="primary"}){
  const styles={
    primary:{background:disabled?"#CBD5E0":"#1A56DB",color:"#fff",border:"none"},
    outline:{background:"transparent",color:"#1A56DB",border:"1.5px solid #BFDBFE"},
    text:{background:"transparent",color:"#64748B",border:"none"},
  }[variant]||{};
  if(primary) Object.assign(styles,{background:disabled?"#CBD5E0":"#1A56DB",color:"#fff",border:"none"});
  return(
    <button onClick={onClick} disabled={disabled||loading}
      style={{padding:"12px 20px",borderRadius:12,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:14,cursor:disabled||loading?"not-allowed":"pointer",opacity:disabled&&!loading?0.6:1,transition:"all 0.2s",...styles}}>
      {loading?"Loading...":label}
    </button>
  );
}

// Mobile detection hook
function useIsMobile(){
  const[m,setM]=useState(typeof window!=="undefined"&&window.innerWidth<640);
  useEffect(()=>{
    const h=()=>setM(window.innerWidth<640);
    window.addEventListener("resize",h);
    return()=>window.removeEventListener("resize",h);
  },[]);
  return m;
}

// Persists state to localStorage so progress survives page refresh
function useLocalState(key, defaultVal){
  const[state,setState]=useState(()=>{
    try{
      const stored=localStorage.getItem(key);
      return stored!==null?JSON.parse(stored):defaultVal;
    }catch{return defaultVal;}
  });
  const setter=(val)=>{
    setState(prev=>{
      const next=typeof val==="function"?val(prev):val;
      try{localStorage.setItem(key,JSON.stringify(next));}catch{}
      return next;
    });
  };
  return[state,setter];
}

const T = {
  navy:"#0F172A",blue:"#2563EB",blueMid:"#3B82F6",blueLight:"#EFF6FF",
  mint:"#059669",mintLight:"#ECFDF5",red:"#DC2626",redLight:"#FEF2F2",
  gold:"#D97706",goldLight:"#FFFBEB",purple:"#7C3AED",purpleLight:"#F5F3FF",
  surface:"#F8FAFC",card:"#FFFFFF",text:"#0F172A",textMid:"#475569",textSoft:"#94A3B8",border:"#E2E8F0",
};

// ── LEARNER TRACKS (v1.5) — one curriculum, reordered / tailored to the goal ──
// focus[] = the skills surfaced first. clb = target benchmark. exam = mock format.
const TRACKS = [
  {id:"clb7", label:"Permanent Residence", sub:"Target CLB 7 · Express Entry", emoji:"🚀", clb:7, exam:"TEF",
   focus:["listening","speaking","reading","writing"],
   blurb:"The full path to CLB 7 across all four skills, with TEF Canada–style practice — the French benchmark for Express Entry PR points."},
  {id:"clb5", label:"Work & Settle", sub:"Target CLB 5 · understand & speak fast", emoji:"🎯", clb:5, exam:"TEF",
   focus:["listening","speaking"],
   blurb:"Functional French, fast. Listening and speaking come first so you can work, shop and handle daily life in Quebec."},
  {id:"casual", label:"Just Learning French", sub:"At your own pace · no exam", emoji:"❤️", clb:0, exam:null,
   focus:["listening","speaking","reading","writing"],
   blurb:"Learn for family, travel or yourself — the whole curriculum, zero exam pressure."},
];
const getTrack = () => { try{ return TRACKS.find(t=>t.id===localStorage.getItem("franco_track")) || TRACKS[0]; }catch{ return TRACKS[0]; } };
// Read the chosen companion (mascot) so any screen can show them cheering the learner on.
const getCompanion = () => { try{ return JSON.parse(localStorage.getItem("franco_companion")) || COMPANIONS[0]; }catch{ return COMPANIONS[0]; } };
// ─────────────────────────────────────────────────────────────────────────────
// FRANCO — FULL CURRICULUM: 190 LESSONS, BEGINNER → CLB 5 / B1
// Each lesson: teach text + vocabulary + 3-4 questions (MCQ & write)
// ─────────────────────────────────────────────────────────────────────────────

const mkL = (id, title, mins, skill, teach, vocab, questions) =>
  ({id, title, mins, skill, teach, vocab, questions});

const mcq = (prompt, options, correct, explain) =>
  ({type:"mcq", prompt, options, correct, explain});

const wr = (prompt, accepted, explain) =>
  ({type:"write", prompt, accepted, explain});

// ── Skill-practice authoring helpers (added v1.5) ──
// li = LISTEN: plays `audio` (French) via on-device TTS, then a comprehension MCQ.
//      extra can carry {once:true} (TEF-style single play), {transcriptEn:"..."}, {diff}.
const li = (audio, prompt, options, correct, explain, extra={}) =>
  ({type:"listen", audio, prompt, options, correct, explain, ...extra});

// rd = READ: shows a real French `passage`, then a comprehension MCQ.
//      extra can carry {title, glossary:[["mot","meaning"]], diff}.
const rd = (passage, prompt, options, correct, explain, extra={}) =>
  ({type:"read", passage, prompt, options, correct, explain, ...extra});

// sp = SPEAK: live mic + speech-recognition scoring via AISpeakingCoach.
//      `accepted` = key words/phrases the spoken answer should contain.
const sp = (prompt, sampleAnswer, accepted, explain) =>
  ({type:"speak", prompt, sampleAnswer, accepted, explain});

// ─────────────────────────────────────────────────────────────────────────────
// FOUNDATION — 20 lessons
// ─────────────────────────────────────────────────────────────────────────────
const FOUNDATION_LESSONS = [
  {
    id:"f-01", title:"Bonjour Canada!", unit:"Unit 1: First Day in Canada",
    mins:15, skill:"mixed", cefrTag:"Pre-A1", recap:null,
    teach:"Imagine this: you just landed at Montreal airport. The customs officer smiles and says Bonjour! You freeze... what do you say? This happens to every new immigrant. Today you learn the 5 magic words that get you through your first day in Canada — and why saying them correctly makes Canadians light up with joy.",
    vocab:["Bonjour (bohn-ZHOOR) = Hello / Good day","Merci (mare-SEE) = Thank you","S'il vous plaît (seel-voo-PLAY) = Please","Oui (WEE) = Yes","Non (NOH) = No","Excusez-moi (ex-koo-ZAY-mwah) = Excuse me","De rien (duh ree-AHN) = You're welcome","Bonne journée (bun zhoor-NAY) = Have a good day"],
    questions:[
      {type:"tap",fr:"Bonjour",opts:["Hello","Goodbye","Thank you","Please"],correct:0,explain:"Bonjour = Hello or Good day! Used ALL day in Quebec — morning, afternoon, evening. Always say it when entering any shop or office. One word, massive impact.",diff:1},
      {type:"tap",fr:"Merci",opts:["Please","Sorry","Thank you","Yes"],correct:2,explain:"Merci = Thank you! Canadians love hearing it. Always say it after any service — at the cashier, doctor, bus driver. Short, warm, and powerful.",diff:1},
      {type:"match",prompt:"Match the French word to its English meaning",pairs:[["Oui","Yes"],["Non","No"],["Merci","Thank you"],["Bonjour","Hello"],["S'il vous plaît","Please"]],explain:"These 5 words are your Day 1 survival kit in Canada! Oui and Non are the most basic — practice them out loud right now.",diff:1},
      {type:"fill",before:"You walk into a pharmacy. You say",blank:"___",after:"to greet the pharmacist.",options:["Bonjour","Au revoir","Merci","Non"],correct:0,explain:"Always greet with Bonjour when entering any store or office in Quebec! It's considered rude not to. Even if your French is basic, this one word shows respect and opens hearts.",diff:1},
      {type:"mcq",prompt:"The customs officer helps you find your luggage. What do you say?",options:["S'il vous plaît","Merci beaucoup","Bonjour","Oui"],correct:1,explain:"Merci beaucoup = Thank you very much! Even better than just merci. Canadians appreciate this warmth — it shows you care about the interaction.",diff:2},
      {type:"scene",story:"Amara arrives at Montreal airport. The officer says 'Bonjour Madame, bienvenue au Canada!' Amara smiles and wants to reply.",prompt:"What should Amara say?",options:["Bonjour! Merci!","Au revoir!","Non merci","Je ne sais pas"],correct:0,explain:"Bonjour! Merci! — Simple and perfect. Respond to Bonjour with Bonjour. Add Merci to show gratitude for the welcome. Canadians will love this!",diff:2},
      {type:"order",prompt:"Build the phrase: Have a good day please",words:["Bonne","journée","s'il","vous","plaît"],answer:["Bonne","journée","s'il","vous","plaît"],explain:"Bonne journée s'il vous plaît — say this leaving any store or office. The staff will be delighted. Small phrase, big impression!",diff:2},
      {type:"write",prompt:"Write how you greet someone when entering a store in French",accepted:["bonjour","bonjour!","bonjour madame","bonjour monsieur","bonjour messieurs dames"],explain:"Bonjour! One word that opens every door in Quebec. In Canada, greeting people when you enter is part of the culture — not optional. You're already sounding Canadian!",diff:2}
    ]
  },
  {
    id:"f-02", title:"Sounds of French", unit:"Unit 1: First Day in Canada",
    mins:20, skill:"listening", cefrTag:"Pre-A1", recap:["f-01"],
    teach:"Your taxi driver from the airport is chatting away and you can't understand a word. Why? French sounds completely different from how it looks! But here's the secret: just 3 rules unlock everything. Rule 1: E says 'uh' not 'ee'. Rule 2: R comes from your throat like a soft gargle. Rule 3: H is always totally silent. Master these 3 today and you'll understand 30% more French immediately.",
    vocab:["E = 'uh' sound (le, me, te, de)","É = 'ay' sound (café, étudiant, médecin)","R = guttural throat sound (rouge, merci, bonjour)","H = ALWAYS silent (hôpital, homme, heure)","OU = 'oo' sound (bonjour, vous, pour)","U = round lips + say 'ee' (tu, rue, lune)","ON = nasal buzz (bon, mon, son, bonjour)","AN = nasal (dans, grand, France, enfant)"],
    questions:[
      {type:"tap",fr:"café",opts:["kaf-AY","KAH-fay","KAY-fay","kaf-EE"],correct:0,explain:"Café = kaf-AY! The accent on é always makes the 'ay' sound. You'll see cafés everywhere in Quebec — now you know how to say it like a local!",diff:1},
      {type:"tap",fr:"hôpital",opts:["HOH-pee-tal","oh-pee-TAL","HOH-pih-tal","hoh-spee-tal"],correct:1,explain:"oh-pee-TAL! H is silent — we start with 'oh'. The accent on ô makes a longer O. In Quebec you'll need this word. Knowing it correctly helps in emergencies!",diff:1},
      {type:"match",prompt:"Match each letter to how it sounds in French",pairs:[["E","uh (like the)"],["É","ay (like say)"],["R","guttural throat"],["H","always silent"],["OU","oo (like moon)"]],explain:"These 5 sound rules unlock French pronunciation completely. Once you know them you can read ANY French word out loud!",diff:2},
      {type:"fill",before:"The French letter H is always",blank:"___",after:"— you never say it out loud.",options:["silent","loud","guttural","nasal"],correct:0,explain:"H is ALWAYS silent in French — no exceptions! hôpital = oh-pee-tal, homme = omm, heure = ur. This is one of the most common mistakes English speakers make. Now you know!",diff:1},
      {type:"mcq",prompt:"How do you say 'bonjour' correctly?",options:["BON-joor","bon-ZHOOR","BON-jour","bohn-JUR"],correct:1,explain:"bon-ZHOOR! The J makes a 'zh' sound (like the s in measure). The R is guttural — from the back of your throat. The most important word in French — say it right!",diff:2},
      {type:"mcq",prompt:"The French U sound (like in 'tu' = you) is made by:",options:["Saying oo normally","Rounding lips for oo then saying ee","Saying you fast","Opening mouth wide"],correct:1,explain:"French U is unique — it doesn't exist in English! Round your lips tight for oo then try to say ee. The tension between them IS the French U. Tu, rue, lune. Practice this and you'll impress every Quebecker!",diff:3},
      {type:"scene",story:"Priya calls the hospital (hôpital) in Montreal. The receptionist answers in French. Priya needs to say she has an appointment (rendez-vous).",prompt:"How does Priya pronounce 'hôpital'?",options:["HOH-pee-tal","oh-pee-TAL","hoh-SPEE-tal","HOH-pih-tal"],correct:1,explain:"oh-pee-TAL — H is silent, ô makes a long O. In emergencies, pronouncing it correctly helps the person understand you immediately. This lesson could literally save your life!",diff:2},
      {type:"speak",prompt:"Say these 3 words out loud focusing on the French sounds: bonjour, merci, café",sampleAnswer:"bonjour merci cafe",accepted:["bonjour","merci","café","cafe"],explain:"Bon-ZHOOR, mare-SEE, kaf-AY! Say them every morning this week and they become automatic. Your French accent is forming right now!",diff:3}
    ]
  },
  {
    id:"f-03", title:"Who Are You?", unit:"Unit 1: First Day in Canada",
    mins:20, skill:"speaking", cefrTag:"Pre-A1", recap:["f-01","f-02"],
    teach:"At every government office, doctor, school registration, job interview — they always ask 'Comment vous appelez-vous?' (What's your name?). Today you learn the 4 sentences that introduce you completely in French. By the end of this lesson you can handle any first meeting in Quebec: name, age, origin, city. These 4 sentences will serve you for years.",
    vocab:["Je m'appelle... = My name is... (literally: I call myself)","J'ai X ans = I am X years old (literally: I have X years!)","Je viens de... = I come from...","J'habite à... = I live in...","Je suis... = I am... (for nationality/profession)","Enchanté(e) = Nice to meet you","Comment vous appelez-vous? = What is your name?","D'où venez-vous? = Where are you from?"],
    questions:[
      {type:"tap",fr:"Je m'appelle",opts:["My name is","I am from","I live in","Nice to meet you"],correct:0,explain:"Je m'appelle = My name is (literally 'I call myself'). Always use this for your name — never 'Je suis [name]'. This is the first phrase in every French introduction!",diff:1},
      {type:"tap",fr:"J'ai 30 ans",opts:["I have 30 years","I am 30 years old","I am 30","I live 30 years"],correct:1,explain:"J'ai 30 ans = I am 30 years old! In French, age uses AVOIR (to have) — literally 'I have 30 years'. Never say 'Je suis 30 ans'. This surprises English speakers every time!",diff:1},
      {type:"match",prompt:"Match the French phrase to its meaning",pairs:[["Je m'appelle Sara","My name is Sara"],["J'ai 28 ans","I am 28 years old"],["Je viens d'Inde","I come from India"],["J'habite à Montréal","I live in Montreal"],["Enchanté!","Nice to meet you!"]],explain:"Put these together and you have a complete French introduction! Practice saying all 5 about yourself right now.",diff:1},
      {type:"fill",before:"Je",blank:"___",after:"à Montréal. (I live in Montreal)",options:["suis","m'appelle","habite","viens"],correct:2,explain:"J'habite à = I live in. Habiter uses 'à' before city names: J'habite à Montréal, J'habite à Toronto, J'habite à Québec. This phrase appears on virtually every form you'll fill in Canada!",diff:2},
      {type:"mcq",prompt:"How do you say 'I am 25 years old' in French?",options:["Je suis 25 ans","J'ai 25 ans","J'habite 25 ans","J'ai 25 années"],correct:1,explain:"J'ai 25 ans! French uses AVOIR (to have) for age. 'Je suis 25 ans' is a very common mistake — it sounds wrong to French speakers. J'ai = I have. J'ai 25 ans. Perfect!",diff:2},
      {type:"order",prompt:"Build the sentence: I come from India",words:["Je","viens","d'Inde"],answer:["Je","viens","d'Inde"],explain:"Je viens d'Inde! Notice: de + Inde = d'Inde (elision). Before a vowel sound, 'de' becomes 'd'. Je viens d'Inde, de France, du Canada, du Maroc.",diff:2},
      {type:"scene",story:"Ravi is at his first day of French class. The teacher says 'Présentez-vous!' (Introduce yourself!). Ravi is 28, from India, lives in Montreal.",prompt:"Which introduction is correct?",options:["Je m'appelle Ravi. J'ai 28 ans. Je viens d'Inde. J'habite à Montréal.","Je suis Ravi. Je suis 28 ans. Je suis d'Inde. Je suis à Montréal.","Mon nom est Ravi. J'ai 28. Inde. Montréal.","Bonjour, Ravi, 28, India, Montreal."],correct:0,explain:"Perfect introduction! Je m'appelle (not je suis for names), J'ai 28 ans (not je suis), Je viens d'Inde (with d' before vowel), J'habite à Montréal. All 4 phrases correct — memorize this pattern!",diff:2},
      {type:"write",prompt:"Introduce yourself in French: write your name, age, where you're from, and where you live",accepted:["je m'appelle","j'ai","ans","je viens","j'habite"],explain:"You just introduced yourself in French! This exact introduction works at government offices, schools, job interviews, and meeting neighbours. You're ready for real Canadian life!",diff:3}
    ]
  },
  {
    id:"f-04", title:"Numbers That Matter", unit:"Unit 1: First Day in Canada",
    mins:20, skill:"listening", cefrTag:"Pre-A1", recap:["f-02","f-03"],
    teach:"Your first bill arrives in Quebec. The cashier says 'Vingt-trois dollars' — how much? You need to fill out a form with your phone number. The doctor asks your age. Numbers are everywhere in daily Canadian life and getting them wrong causes real problems. Today you learn 1-31 (enough for dates, ages, addresses, and prices) in the most memorable way possible.",
    vocab:["1-10: un, deux, trois, quatre, cinq, six, sept, huit, neuf, dix","11-16: onze, douze, treize, quatorze, quinze, seize","17-19: dix-sept, dix-huit, dix-neuf","20: vingt | 21: vingt et un | 22: vingt-deux","30: trente | 31: trente et un","100: cent | 1000: mille","premier/première = first (1st)","deuxième = second | troisième = third"],
    questions:[
      {type:"tap",fr:"trois",opts:["2","3","4","13"],correct:1,explain:"Trois = 3! Pronounced 'twah'. You'll hear this constantly: trois dollars, trois personnes, trois heures. The S is silent — it's 'twah' not 'twas'.",diff:1},
      {type:"tap",fr:"vingt",opts:["12","20","21","200"],correct:1,explain:"Vingt = 20! Pronounced 'van' (the T and G are silent). Vingt et un = 21, vingt-deux = 22. Vingt appears constantly in prices and ages.",diff:1},
      {type:"match",prompt:"Match the French number to its value",pairs:[["cinq","5"],["dix","10"],["quinze","15"],["vingt","20"],["trente","30"]],explain:"Cinq (5), dix (10), quinze (15), vingt (20), trente (30) — these multiples of 5 are the most useful numbers to know first!",diff:1},
      {type:"mcq",prompt:"The cashier says 'Vingt-trois dollars s'il vous plaît'. How much is it?",options:["$13","$20","$23","$32"],correct:2,explain:"Vingt (20) + trois (3) = vingt-trois = 23! In Quebec, prices are said this way. Knowing your numbers means you'll never be overcharged or confused at checkout.",diff:2},
      {type:"fill",before:"Mon numéro de téléphone est cinq, un, quatre,",blank:"___",after:", sept, huit, neuf, zéro.",options:["deux","trois","cinq","six"],correct:1,explain:"Trois = 3! Phone numbers in Quebec are said digit by digit. Practice saying your own phone number in French — it comes up at every appointment and registration.",diff:2},
      {type:"scene",story:"Sara is at the government office. The agent says 'Quel est votre code postal? (What's your postal code?)' Sara's postal code is H3A 2T6.",prompt:"How does Sara say the numbers 3 and 2 in French?",options:["trois et deux","three and two","trente et vingt","trois, deux"],correct:3,explain:"Trois, deux — postal codes and phone numbers are said digit by digit, not as full numbers. H trois A deux T six. Now practice your own postal code!",diff:2},
      {type:"order",prompt:"Say the price: twenty-five dollars",words:["vingt","cinq","dollars"],answer:["vingt","cinq","dollars"],explain:"Vingt-cinq dollars! Note: 21, 31, 41... use 'et un' (vingt et un). But 22-29 just hyphenate: vingt-deux, vingt-cinq. No 'et' for 22-29!",diff:3},
      {type:"write",prompt:"Write the number 23 in French words",accepted:["vingt-trois","vingt trois"],explain:"Vingt-trois! The hyphen is important in writing. Vingt (20) + trois (3). Numbers 17-19 use dix-sept, dix-huit, dix-neuf — literally ten-seven, ten-eight, ten-nine. French numbers are very logical once you see the pattern!",diff:2}
    ]
  },
  {
    id:"f-05", title:"Your New Home", unit:"Unit 2: Finding a Home",
    mins:25, skill:"mixed", cefrTag:"Pre-A1", recap:["f-03","f-04"],
    teach:"Finding an apartment in Quebec is one of the first big challenges for immigrants. The landlord calls and asks questions in French. You need to understand: how many rooms, what floor, how much per month. Today's lesson is based on a real scenario — Sara calls about an apartment she saw on Kijiji. By the end you'll know the vocabulary to find your first home in French Canada.",
    vocab:["un appartement = an apartment","un loyer = rent","une chambre = a bedroom","la salle de bain = bathroom","la cuisine = kitchen","le salon = living room","au premier étage = on the first floor","C'est combien? = How much is it?","C'est disponible quand? = When is it available?","Je suis intéressé(e) = I am interested"],
    questions:[
      {type:"tap",fr:"un loyer",opts:["a bedroom","a bathroom","rent","a kitchen"],correct:2,explain:"Un loyer = rent! Every apartment listing in Quebec mentions the loyer. 'Le loyer est de 1200$ par mois' = The rent is $1200 per month. You'll see this word constantly.",diff:1},
      {type:"tap",fr:"la salle de bain",opts:["the living room","the bathroom","the bedroom","the kitchen"],correct:1,explain:"La salle de bain = the bathroom (literally 'the room of bath'). A key word for apartment hunting! '1 salle de bain' or '2 salles de bain' — always check!",diff:1},
      {type:"match",prompt:"Match the French room name to English",pairs:[["le salon","living room"],["la cuisine","kitchen"],["une chambre","a bedroom"],["la salle de bain","bathroom"],["le balcon","balcony"]],explain:"These are the 5 main rooms of any Quebec apartment! Knowing them lets you understand any listing on Kijiji, Marketplace, or through an agent.",diff:1},
      {type:"fill",before:"Sara asks: C'est",blank:"___",after:"par mois? (How much per month?)",options:["combien","quand","où","disponible"],correct:0,explain:"C'est combien? = How much is it? The most useful question for any transaction in Quebec. Combien means 'how much' or 'how many'. Essential for shopping, rent, services!",diff:2},
      {type:"mcq",prompt:"The landlord says 'L'appartement a deux chambres et un salon'. What does this mean?",options:["The apartment has 2 bathrooms and a kitchen","The apartment has 2 bedrooms and a living room","The apartment has 2 floors and a balcony","The apartment has 2 kitchens and a room"],correct:1,explain:"Deux chambres = 2 bedrooms, un salon = a living room! Chambres always means bedrooms in apartment context. Now you can understand any apartment listing in Quebec!",diff:2},
      {type:"scene",story:"Sara calls about an apartment. The landlord says 'Bonjour, l'appartement est au deuxième étage, loyer 1100$ par mois, disponible le 1er juillet.'",prompt:"What did Sara just learn about the apartment?",options:["2nd floor, $1100/month, available July 1st","1st floor, $1100/month, available June 1st","2nd floor, $1000/month, available July 1st","3rd floor, $1100/month, available July 1st"],correct:0,explain:"Deuxième étage = 2nd floor, 1100$ par mois = $1100 per month, disponible le 1er juillet = available July 1st. You just understood a real phone conversation in French — incredible progress!",diff:3},
      {type:"order",prompt:"Build Sara's question: How much is the rent?",words:["C'est","combien","le","loyer?"],answer:["C'est","combien","le","loyer?"],explain:"C'est combien le loyer? — a natural, perfect question any Quebecer would understand immediately. Practice saying it out loud — you'll use this in real life very soon!",diff:2},
      {type:"write",prompt:"Write how you would say you are interested in an apartment in French",accepted:["je suis intéressé","je suis intéressée","je suis interesse","intéressé","interested"],explain:"Je suis intéressé(e)! The (e) at the end is added if you're a woman — intéressée. This phrase works on the phone, by email, or in person. Simple and professional!",diff:3}
    ]
  },
  {
    id:"f-06", title:"Big Numbers & Prices", unit:"Unit 2: Finding a Home",
    mins:20, skill:"listening", cefrTag:"Pre-A1", recap:["f-04"],
    teach:"Your rent is 1200 dollars. Your phone bill is 95 dollars. The metro pass is 97 dollars. You need to understand prices in Quebec to manage your money. French numbers from 20-100 follow special patterns — and 70, 80, 90 are SURPRISING (vingt, quarante… then soixante-dix? Yes!). After this lesson you'll handle any price, bill, or amount in Canada.",
    vocab:["20 vingt | 30 trente | 40 quarante | 50 cinquante","60 soixante | 70 soixante-dix (60+10!) | 71 soixante et onze","80 quatre-vingts (4×20!) | 81 quatre-vingt-un","90 quatre-vingt-dix (4×20+10) | 99 quatre-vingt-dix-neuf","100 cent | 200 deux cents | 1000 mille","C'est combien? = How much is it?","Ça coûte... dollars = It costs... dollars","par mois = per month | par semaine = per week"],
    questions:[
      {type:"tap",fr:"soixante",opts:["50","60","70","80"],correct:1,explain:"Soixante = 60! Pronounced 'swa-SAHNT'. Then 70 is soixante-dix (60+10). It's strange but logical: French numbers stop being regular at 70. Memorize this jump now!",diff:1},
      {type:"tap",fr:"quatre-vingts",opts:["20","40","80","90"],correct:2,explain:"Quatre-vingts = 80 (literally 'four twenties'!). Yes, French counts in 20s for 80-99. This is unique to French — Belgian and Swiss French use 'huitante' instead. In Quebec/Canada we use quatre-vingts.",diff:2},
      {type:"match",prompt:"Match French numbers to values",pairs:[["cinquante","50"],["soixante","60"],["quatre-vingts","80"],["cent","100"],["mille","1000"]],explain:"These 5 milestone numbers cover most prices and amounts you'll deal with in Canada. Practice them — they show up in rent, salary, bills, taxes!",diff:2},
      {type:"fill",before:"Le loyer est",blank:"___",after:"dollars par mois. (1200 dollars per month)",options:["mille deux cents","mille deux","douze cents","cent vingt"],correct:0,explain:"1200 = mille deux cents (one thousand two hundred). 'Mille' for 1000, 'deux cents' for 200. Note: cents has 's' here because it's plural without a following number. With a following number: 'deux cent vingt' = 220.",diff:3},
      {type:"mcq",prompt:"The cashier says 'Quatre-vingt-quinze dollars'. How much do you owe?",options:["$85","$95","$415","$420"],correct:1,explain:"Quatre-vingt-quinze = 95 (4×20 + 15). This pattern is everywhere in Quebec stores. quatre-vingt-dix-neuf = 99. Now you can handle any cash transaction!",diff:3},
      {type:"scene",story:"Priya is paying rent at her landlord's office. He says: 'Ce mois-ci, c'est mille deux cent cinquante dollars.'",prompt:"How much rent is Priya paying this month?",options:["$1,025","$1,250","$1,025.50","$1,520"],correct:1,explain:"Mille (1000) + deux cent (200) + cinquante (50) = 1250. Quebec landlords often state amounts this way. Always confirm by writing it down or asking 'Pouvez-vous l'écrire?' (Can you write it?)",diff:3},
      {type:"order",prompt:"Build the price: It costs eighty-five dollars",words:["Ça","coûte","quatre-vingt-cinq","dollars"],answer:["Ça","coûte","quatre-vingt-cinq","dollars"],explain:"Ça coûte quatre-vingt-cinq dollars! 'Ça coûte' is the most common way to state prices. Use 'coûte' (singular). For Quebec, you'll hear this constantly at any shop or service.",diff:2},
      {type:"write",prompt:"Write the price 'one hundred fifty dollars' in French",accepted:["cent cinquante dollars","cent cinquante","150 dollars"],explain:"Cent cinquante dollars! No 's' on cent (it's followed by another number). Practice writing prices — you'll need this skill for invoices, contracts, rent receipts.",diff:3}
    ]
  },
  {
    id:"f-07", title:"Telling Time in Quebec", unit:"Unit 3: Daily Life",
    mins:20, skill:"speaking", cefrTag:"Pre-A1", recap:["f-04","f-06"],
    teach:"What time is your appointment? When does the bus come? At what time does the office close? Time is everywhere in Canadian daily life. French time-telling has a few quirks — Quebec uses both 12-hour and 24-hour formats, and there are special words for half-past and quarter-past. Today you master telling and asking time so you'll never miss an appointment again.",
    vocab:["Quelle heure est-il? = What time is it?","Il est... heure(s) = It is... o'clock","Il est huit heures = It's 8 o'clock","Il est huit heures et demie = 8:30","Il est huit heures et quart = 8:15","Il est neuf heures moins le quart = 8:45","midi = noon (12:00 day)","minuit = midnight (12:00 night)"],
    questions:[
      {type:"tap",fr:"Quelle heure est-il?",opts:["What day is it?","What time is it?","Where is it?","How is it?"],correct:1,explain:"Quelle heure est-il? = What time is it? Most natural way to ask the time in French. Pronounced 'kel ur ay-teel'. Use it with anyone — bus driver, store clerk, colleague!",diff:1},
      {type:"tap",fr:"Il est huit heures et demie",opts:["8:00","8:15","8:30","8:45"],correct:2,explain:"Il est huit heures et demie = 8:30 (literally 'eight hours and half'). 'Et demie' means 'and a half' — super common in French time. 'Huit heures et demie du matin' = 8:30 AM.",diff:2},
      {type:"match",prompt:"Match French time to clock value",pairs:[["midi","12:00 noon"],["minuit","12:00 midnight"],["et quart","quarter past"],["et demie","half past"],["moins le quart","quarter to"]],explain:"Master these 5 time concepts and you can express any time in French! Quebec uses these constantly in daily speech.",diff:2},
      {type:"fill",before:"Il est dix heures",blank:"___",after:". (10:30)",options:["et quart","et demie","moins le quart","trente"],correct:1,explain:"Et demie = and a half (30 minutes past). 'Dix heures et demie' = 10:30. Note: 'demie' has -e ending here because heure is feminine. After midi/minuit it's 'demi' (no -e).",diff:2},
      {type:"mcq",prompt:"Your doctor's office says 'Votre rendez-vous est à treize heures trente'. What time is your appointment?",options:["1:30 PM","3:30 PM","1:30 AM","11:30 AM"],correct:0,explain:"13h30 = 1:30 PM! Government and medical appointments in Quebec use 24-hour time (13h00 = 1 PM, 14h00 = 2 PM). Always convert: subtract 12 from anything 13-23 to get PM time.",diff:3},
      {type:"scene",story:"You ask a stranger in Montreal: 'Excusez-moi, quelle heure est-il s'il vous plaît?' She replies: 'Il est neuf heures moins le quart.'",prompt:"What time is it?",options:["9:15","9:00","8:45","8:15"],correct:2,explain:"Moins le quart = quarter to (subtract 15 minutes). Neuf heures moins le quart = 8:45 (15 minutes before 9). This phrasing is very common in Quebec. Always think: 'minus 15' from the next hour.",diff:3},
      {type:"order",prompt:"Build the answer: It is half past three",words:["Il","est","trois","heures","et","demie"],answer:["Il","est","trois","heures","et","demie"],explain:"Il est trois heures et demie! Notice 'heures' has -s because it's after 2 (plural). Heure is singular only for 1 o'clock: 'une heure'.",diff:2},
      {type:"write",prompt:"Write 'It is 7 o'clock' in French",accepted:["il est sept heures","sept heures","il est 7 heures"],explain:"Il est sept heures! Always use 'heures' (plural) for any number except 1. Practice with all the times — your French gets natural quickly.",diff:3}
    ]
  },
  {
    id:"f-08", title:"Days, Months & Dates", unit:"Unit 3: Daily Life",
    mins:20, skill:"reading", cefrTag:"Pre-A1", recap:["f-04","f-07"],
    teach:"Appointments, work schedules, school dates, deadlines for documents — every Canadian needs to read and write dates in French. Quebec uses the format Day Month Year (different from US!), and French capitalizes days and months differently from English. Today you learn the 7 days, 12 months, and how to say any date naturally.",
    vocab:["lundi, mardi, mercredi, jeudi, vendredi, samedi, dimanche","janvier, février, mars, avril, mai, juin","juillet, août, septembre, octobre, novembre, décembre","aujourd'hui = today | demain = tomorrow | hier = yesterday","la semaine = week | le mois = month | l'année = year","Quelle est la date? = What is the date?","le 5 janvier 2026 = January 5th, 2026","On est quel jour? = What day is it?"],
    questions:[
      {type:"tap",fr:"vendredi",opts:["Monday","Wednesday","Friday","Sunday"],correct:2,explain:"Vendredi = Friday! French days are NOT capitalized (unlike English). The French week starts with lundi (Monday), unlike the English week which starts Sunday. Pay attention to this in your calendar!",diff:1},
      {type:"tap",fr:"août",opts:["April","June","August","October"],correct:2,explain:"Août = August! Pronounced 'oot' (silent A). French months are NOT capitalized. Note the special accent on 'û'. You'll write this on every official form.",diff:2},
      {type:"match",prompt:"Match days of the week",pairs:[["lundi","Monday"],["mercredi","Wednesday"],["samedi","Saturday"],["dimanche","Sunday"],["jeudi","Thursday"]],explain:"All 7 French days end in 'di' (except dimanche). Lundi = day of the moon (lune). Mercredi = day of Mercury. Linguistic fun!",diff:2},
      {type:"fill",before:"Mon rendez-vous est",blank:"___",after:"15 mars. (My appointment is March 15th)",options:["le","la","au","du"],correct:0,explain:"Le 15 mars! All French dates use 'le' before the number. 'Le 15 mars' = on March 15th. NEVER use 'on' translation directly. The article 'le' does the work.",diff:2},
      {type:"mcq",prompt:"Your friend says 'On se voit lundi prochain'. When are you meeting?",options:["Last Monday","Tomorrow","Next Monday","This Sunday"],correct:2,explain:"Lundi prochain = next Monday! 'Prochain/prochaine' = next. 'Lundi dernier' = last Monday. Use 'on se voit' to make plans casually with friends.",diff:2},
      {type:"scene",story:"At the doctor's office, the receptionist hands you an appointment card: 'Votre prochain rendez-vous: jeudi 12 février 2026 à 14h30.'",prompt:"When is your appointment?",options:["Tuesday Feb 12, 2026 at 2:30 PM","Thursday Feb 12, 2026 at 2:30 PM","Thursday Feb 12, 2026 at 4:30 PM","Friday Feb 12, 2026 at 2:30 PM"],correct:1,explain:"Jeudi (Thursday) 12 février (12 February) 2026 à 14h30 (2:30 PM). Quebec medical appointments always use this format. Now you can read your own appointment cards confidently!",diff:3},
      {type:"order",prompt:"Build the date: Today is Wednesday, May 5th",words:["Aujourd'hui,","on","est","mercredi","le","5","mai"],answer:["Aujourd'hui,","on","est","mercredi","le","5","mai"],explain:"Aujourd'hui, on est mercredi le 5 mai! Or shorter: 'On est le 5 mai'. The day name is optional but adds context. 'On est' means 'it is' (informal/conversational).",diff:3},
      {type:"write",prompt:"Write 'My birthday is March 21st' in French",accepted:["mon anniversaire est le 21 mars","c'est le 21 mars","21 mars"],explain:"Mon anniversaire est le 21 mars! 'Mon anniversaire' = my birthday. French uses 'le' + number + month for dates. Practice your own birthday — it'll come up at every social gathering!",diff:3}
    ]
  },
  {
    id:"f-09", title:"Politeness That Opens Doors", unit:"Unit 3: Daily Life",
    mins:15, skill:"speaking", cefrTag:"Pre-A1", recap:["f-01","f-03"],
    teach:"In Quebec, politeness isn't optional — it's culture. Saying 'Excusez-moi' before asking, 'Merci beaucoup' after receiving help, 'Pardon' when bumping into someone — these tiny phrases open every door. Quebecers will be 10× warmer to you when you use them. Today you learn the polite phrases that turn strangers into helpers.",
    vocab:["Excusez-moi = Excuse me (formal/strangers)","Pardon = Sorry / Excuse me","S'il vous plaît = Please (formal)","Merci beaucoup = Thank you very much","De rien = You're welcome","Je vous en prie = You're welcome (formal)","Désolé(e) = Sorry","Pouvez-vous m'aider? = Can you help me?"],
    questions:[
      {type:"tap",fr:"Excusez-moi",opts:["Goodbye","Excuse me","Please","Thank you"],correct:1,explain:"Excusez-moi = Excuse me! Use this BEFORE asking strangers anything in Quebec. It's like saying 'Sorry to bother you'. Without it, you sound rude. With it, people will gladly help you.",diff:1},
      {type:"tap",fr:"De rien",opts:["You're welcome","Goodbye","No thank you","No problem"],correct:0,explain:"De rien = You're welcome (literally 'of nothing'). Always respond to merci with de rien. It's automatic in Quebec — your friend says merci, you say de rien!",diff:1},
      {type:"match",prompt:"Match the polite phrase to its use",pairs:[["Excusez-moi","Before asking a stranger"],["Désolé","After making a mistake"],["Merci beaucoup","After receiving help"],["S'il vous plaît","Asking politely"],["Pardon","After bumping someone"]],explain:"Each phrase has its moment. Use them all and you'll fit into Quebec culture seamlessly!",diff:2},
      {type:"fill",before:"You bump into someone in the metro. You say:",blank:"___",after:".",options:["Pardon","Bonjour","Merci","Oui"],correct:0,explain:"Pardon! Quick, automatic, polite. Quebecers say it instantly when bumping into someone. Don't say nothing — that's considered rude. One word fixes it!",diff:2},
      {type:"mcq",prompt:"You need directions from a stranger. The most polite way to start is:",options:["Hey, où est...?","Excusez-moi, pouvez-vous m'aider?","Merci, où est...?","Bonjour!"],correct:1,explain:"Excusez-moi, pouvez-vous m'aider? = Excuse me, can you help me? Maximum politeness, maximum helpfulness from the stranger. This phrase works every single time in Quebec!",diff:2},
      {type:"scene",story:"In a pharmacy, the cashier helps you find your medication. After paying, you want to thank her warmly.",prompt:"What do you say?",options:["De rien!","Au revoir!","Merci beaucoup, bonne journée!","Bonjour!"],correct:2,explain:"Merci beaucoup, bonne journée! = Thank you very much, have a good day! This warm goodbye is THE Quebec standard. The cashier will smile and likely respond 'À vous aussi!' (You too!).",diff:2},
      {type:"order",prompt:"Build the polite request: Excuse me, can you help me please?",words:["Excusez-moi,","pouvez-vous","m'aider","s'il","vous","plaît?"],answer:["Excusez-moi,","pouvez-vous","m'aider","s'il","vous","plaît?"],explain:"Excusez-moi, pouvez-vous m'aider s'il vous plaît? Triple politeness — excusez-moi + pouvez-vous + s'il vous plaît. Strangers will be eager to help when you use this!",diff:3},
      {type:"write",prompt:"Write a polite thank you for help received",accepted:["merci beaucoup","merci","merci pour","je vous remercie"],explain:"Merci beaucoup! Or even more formal: 'Je vous remercie' (literally 'I thank you'). Either works. The KEY is to actually say something — silence after help is rude in Quebec!",diff:2}
    ]
  },
  {
    id:"f-10", title:"When You Don't Understand", unit:"Unit 3: Daily Life",
    mins:15, skill:"speaking", cefrTag:"Pre-A1", recap:["f-02","f-09"],
    teach:"You're new to French. Sometimes people speak too fast. Sometimes they use words you don't know. The fear of looking stupid stops most newcomers from learning faster. Today you learn the EXACT phrases that say 'I don't understand, please help' — politely, clearly, and confidently. These 6 phrases will save you in every confusing moment in Canada.",
    vocab:["Je ne comprends pas = I don't understand","Pouvez-vous répéter? = Can you repeat?","Plus lentement, s'il vous plaît = More slowly, please","Comment dit-on... en français? = How do you say... in French?","Qu'est-ce que ça veut dire? = What does that mean?","Je parle un peu français = I speak a little French","Je suis débutant(e) = I am a beginner","Pouvez-vous l'écrire? = Can you write it?"],
    questions:[
      {type:"tap",fr:"Je ne comprends pas",opts:["I love it","I don't understand","I am tired","I am a student"],correct:1,explain:"Je ne comprends pas = I don't understand! Memorize this NOW — you'll use it every day at first. Pronounced 'zhuh nuh kom-PRAHN pah'. People will switch to slower French immediately when they hear it.",diff:1},
      {type:"tap",fr:"Pouvez-vous répéter?",opts:["Can you help?","Can you wait?","Can you repeat?","Can you stop?"],correct:2,explain:"Pouvez-vous répéter? = Can you repeat? Most useful question for new speakers. Don't be embarrassed — most Quebecers are happy to slow down and repeat. Just ask!",diff:1},
      {type:"match",prompt:"Match the survival phrase to its situation",pairs:[["Je ne comprends pas","Lost in conversation"],["Plus lentement","They speak too fast"],["Comment dit-on","Looking for a word"],["Pouvez-vous l'écrire","You need to see it"],["Je suis débutant","Setting expectations"]],explain:"Each phrase rescues a different situation. Memorize ALL of them — they'll come up at different times every week!",diff:2},
      {type:"fill",before:"The cashier speaks fast. You say 'Plus",blank:"___",after:", s'il vous plaît.' (More slowly, please)",options:["lentement","fort","clair","tard"],correct:0,explain:"Plus lentement = More slowly. Lentement comes from 'lent' (slow). 'Plus' makes it 'more'. Together: 'more slowly please'. The cashier will instantly speak slower!",diff:2},
      {type:"mcq",prompt:"You hear a word you don't know — 'fauteuil'. How do you ask its meaning politely?",options:["What is fauteuil?","Qu'est-ce que ça veut dire 'fauteuil'?","Fauteuil!","Bonjour fauteuil"],correct:1,explain:"Qu'est-ce que ça veut dire? = What does that mean? Then add the word in quotes. 'Fauteuil' means armchair, by the way! This phrase works for ANY mystery French word.",diff:2},
      {type:"scene",story:"On the phone with Hydro-Québec (electric company), the agent speaks really fast. You're missing key information about your bill.",prompt:"What do you politely say to slow them down?",options:["Excusez-moi, je suis débutant en français. Pouvez-vous parler plus lentement, s'il vous plaît?","Stop! No French!","Bonjour, je ne sais pas.","Au revoir."],correct:0,explain:"Excusez-moi, je suis débutant en français. Pouvez-vous parler plus lentement, s'il vous plaît? — A polite, complete sentence that explains your situation AND asks for what you need. Most agents will gladly help!",diff:3},
      {type:"order",prompt:"Build the question: How do you say 'apartment' in French?",words:["Comment","dit-on","'apartment'","en","français?"],answer:["Comment","dit-on","'apartment'","en","français?"],explain:"Comment dit-on 'apartment' en français? Answer: appartement! This phrase is your friend for vocabulary learning — use it whenever you don't know a word. Quebecers love teaching new immigrants!",diff:3},
      {type:"write",prompt:"Write 'Can you write it please?' in French",accepted:["pouvez-vous l'écrire","pouvez-vous l'ecrire","l'écrire s'il vous plaît","écrire s'il vous plaît"],explain:"Pouvez-vous l'écrire s'il vous plaît? When you can't catch a word by ear, ask them to write it down. ESSENTIAL for phone numbers, addresses, prices. They'll happily oblige!",diff:3}
    ]
  },
  {
    id:"f-11", title:"Colors & Describing", unit:"Unit 4: Daily Vocabulary",
    mins:15, skill:"reading", cefrTag:"Pre-A1", recap:["f-09"],
    teach:"Colors come up everywhere — describing your car to police, finding a friend in a crowd, choosing items at a store. French colors must agree with the noun's gender and number, which is a key concept for ALL adjectives. Today you learn the 12 essential colors plus the rule that powers French grammar: adjective agreement.",
    vocab:["rouge = red | bleu = blue | jaune = yellow","vert = green | noir = black | blanc = white","gris = grey | brun = brown | rose = pink","orange = orange | violet = purple","une voiture rouge = a red car (feminine)","un sac rouge = a red bag (masculine)","des chaussures rouges = red shoes (plural)"],
    questions:[
      {type:"tap",fr:"bleu",opts:["red","blue","green","black"],correct:1,explain:"Bleu = blue! Pronounced 'bluh'. The 'eu' sound is a French vowel that doesn't exist in English — somewhere between 'eh' and 'oo'. Practice: 'bleu, bleu, bleu'.",diff:1},
      {type:"tap",fr:"blanc",opts:["black","white","brown","green"],correct:1,explain:"Blanc = white (masculine). Feminine = blanche. 'Une chemise blanche' = a white shirt. 'Un mur blanc' = a white wall. Always think gender when describing!",diff:1},
      {type:"match",prompt:"Match the color to its English",pairs:[["rouge","red"],["vert","green"],["jaune","yellow"],["noir","black"],["rose","pink"]],explain:"Five colors that come up daily: rouge (stop signs), vert (parks/maple), jaune (taxis), noir (suits), rose (flowers). Master these first!",diff:1},
      {type:"fill",before:"J'ai une voiture",blank:"___",after:". (I have a green car — feminine noun)",options:["vert","verte","vertes","verts"],correct:1,explain:"Verte! Voiture is feminine, so 'vert' becomes 'verte' (add -e). This is the FOUNDATION of French grammar: adjectives agree with nouns. Memorize: feminine = add -e.",diff:3},
      {type:"mcq",prompt:"How do you say 'black shoes' (plural feminine)?",options:["chaussures noir","chaussures noires","chaussure noire","chaussures noirs"],correct:1,explain:"Chaussures noires! Chaussures is plural feminine, so 'noir' becomes 'noires' (add -e for feminine, add -s for plural). Pattern: noir → noire → noires.",diff:3},
      {type:"scene",story:"You're describing your lost wallet to a security guard. It's a brown leather wallet.",prompt:"What do you say?",options:["J'ai perdu un portefeuille brun","J'ai perdu une portefeuille brune","J'ai perdu un portefeuille brune","Mon portefeuille brun"],correct:0,explain:"J'ai perdu un portefeuille brun! Portefeuille is masculine, so brun stays as brun (no agreement needed). 'J'ai perdu' = I have lost. Essential phrase for losing items in Quebec!",diff:3},
      {type:"order",prompt:"Build: I have a red car",words:["J'ai","une","voiture","rouge"],answer:["J'ai","une","voiture","rouge"],explain:"J'ai une voiture rouge! Note: 'rouge' doesn't change for gender (it ends in -e already). Some colors are 'invariable' for gender: rouge, jaune, rose, orange. Easier to use!",diff:2},
      {type:"write",prompt:"Write 'My bag is blue' in French (bag = sac, masculine)",accepted:["mon sac est bleu","mon sac est bleu.","sac est bleu"],explain:"Mon sac est bleu! Sac is masculine, so bleu stays bleu. If sac were feminine, it would be 'bleue'. Always check the article (le/la/un/une) for gender clues!",diff:3}
    ]
  },
  {
    id:"f-12", title:"Family — Ma Famille", unit:"Unit 4: Daily Vocabulary",
    mins:15, skill:"speaking", cefrTag:"Pre-A1", recap:["f-03"],
    teach:"At every social event in Canada, people ask about your family. Children, partner, parents, siblings. Today you learn family vocabulary plus the possessive adjectives (my, your, his, her). Family words also teach you about French gender — almost every family word has a male/female pair (frère/soeur, oncle/tante).",
    vocab:["la famille = family","le père = father | la mère = mother","le frère = brother | la soeur = sister","le fils = son | la fille = daughter","l'oncle = uncle | la tante = aunt","le grand-père = grandfather | la grand-mère = grandmother","mon, ma, mes = my (masc/fem/plural)","ton, ta, tes = your (informal)"],
    questions:[
      {type:"tap",fr:"la mère",opts:["the father","the mother","the sister","the aunt"],correct:1,explain:"La mère = the mother! Pronounced 'lah mehr'. Sounds like English 'mare' but with the French R. 'Ma mère' = my mother. The most important word — use it warmly!",diff:1},
      {type:"tap",fr:"le frère",opts:["the brother","the friend","the husband","the cousin"],correct:0,explain:"Le frère = the brother! 'J'ai un frère' = I have a brother. The accent on è makes 'eh' sound. Brother = frère, sister = soeur. Memorize the pair together!",diff:1},
      {type:"match",prompt:"Match family members",pairs:[["le père","father"],["la soeur","sister"],["le fils","son"],["l'oncle","uncle"],["la grand-mère","grandmother"]],explain:"Notice: most family words come in male/female pairs. père/mère, frère/soeur, fils/fille, oncle/tante. Learn them as pairs!",diff:2},
      {type:"fill",before:"Voici",blank:"___",after:"mère, Sara. (This is my mother, Sara)",options:["mon","ma","mes","ton"],correct:1,explain:"Ma! Mère is feminine, so 'my' becomes 'ma'. Pattern: mon (masc), ma (fem), mes (plural). Mon père, ma mère, mes parents.",diff:2},
      {type:"mcq",prompt:"Your friend asks 'As-tu des frères et soeurs?' What did they ask?",options:["Do you have a phone?","Do you have brothers and sisters?","Do you have time?","Do you live alone?"],correct:1,explain:"As-tu des frères et soeurs? = Do you have brothers and sisters? VERY common question when meeting Quebecers. Reply: 'J'ai un frère et deux soeurs' = I have one brother and two sisters.",diff:2},
      {type:"scene",story:"At a Quebec dinner party, the host points to a photo: 'Voilà ma famille — mon mari, mes deux enfants, et mes parents qui habitent à Québec.'",prompt:"What did the host show you?",options:["Her family — husband, 2 kids, parents in Quebec City","Her work team","Her neighbors","Her in-laws"],correct:0,explain:"Mon mari (my husband), mes deux enfants (my 2 kids), mes parents qui habitent à Québec (my parents who live in Quebec City). 'Qui' = who. Real Quebec family conversation!",diff:3},
      {type:"order",prompt:"Build: I have two children",words:["J'ai","deux","enfants"],answer:["J'ai","deux","enfants"],explain:"J'ai deux enfants! Enfants = children (always plural for more than one, gender-neutral). 'Un enfant' = one child. Quebec families love hearing about your kids!",diff:2},
      {type:"write",prompt:"Write 'My sister lives in Toronto'",accepted:["ma soeur habite à toronto","ma soeur habite a toronto","ma soeur vit à toronto"],explain:"Ma soeur habite à Toronto! 'Soeur' is feminine = ma soeur. Habiter à + city. Common conversation starter when meeting fellow immigrants!",diff:3}
    ]
  },
  {
    id:"f-13", title:"Weather in Canada", unit:"Unit 4: Daily Vocabulary",
    mins:15, skill:"reading", cefrTag:"Pre-A1", recap:["f-08"],
    teach:"Canadians LOVE talking about weather. It's the universal small-talk topic — at the bus stop, in elevators, with strangers. And in Canada, weather actually MATTERS: temperatures swing from -30°C to +30°C across seasons. Today you learn weather vocabulary, the 4 seasons, and how to do small talk like a true Canadian.",
    vocab:["Quel temps fait-il? = What's the weather like?","Il fait beau = It's nice (weather)","Il fait froid = It's cold | Il fait chaud = It's hot","Il pleut = It's raining | Il neige = It's snowing","le printemps = spring | l'été = summer","l'automne = fall | l'hiver = winter","Il fait moins vingt = It's minus 20","une tempête de neige = a snowstorm"],
    questions:[
      {type:"tap",fr:"Il pleut",opts:["It's snowing","It's hot","It's raining","It's cold"],correct:2,explain:"Il pleut = It's raining! From the verb 'pleuvoir' (to rain). 'Il pleut beaucoup à Vancouver' = It rains a lot in Vancouver. One of the most useful weather phrases in Canada!",diff:1},
      {type:"tap",fr:"Il fait froid",opts:["It's hot","It's cold","It's nice","It's windy"],correct:1,explain:"Il fait froid = It's cold! 'Faire' (to make/do) is used for weather. Quebec winters get to -30°C — you'll say 'Il fait FROID!' a LOT. Pronounced 'eel feh frwah'.",diff:1},
      {type:"match",prompt:"Match the seasons",pairs:[["le printemps","spring"],["l'été","summer"],["l'automne","fall"],["l'hiver","winter"],["la neige","snow"]],explain:"4 seasons in Canada — and you'll experience all of them in extreme form! L'hiver (winter) is the longest. L'été (summer) is short and intense. Master these words for daily small talk!",diff:1},
      {type:"fill",before:"En janvier, à Montréal,",blank:"___",after:"souvent. (In January in Montreal, it ___ often)",options:["il neige","il fait beau","il fait chaud","c'est"],correct:0,explain:"Il neige! Quebec winters = constant snow from December to March. 'Il neige souvent' = it snows often. Knowing this prepares you for the weather conversations every Canadian has daily!",diff:2},
      {type:"mcq",prompt:"Your colleague says 'Il fait moins quinze aujourd'hui!' What did they say?",options:["It's 15°C today","It's -15°C today","It's nice today","It's the 15th today"],correct:1,explain:"Moins quinze = -15°C! In Canada, 'moins' before a number = minus. -15°C is normal in Montreal in January. Bundle up! 'Habille-toi chaud!' = Dress warm!",diff:2},
      {type:"scene",story:"Waiting for the bus in Montreal in February. A stranger says: 'Ouf, il fait vraiment froid aujourd'hui, hein?'",prompt:"What's the polite Canadian response?",options:["Oui, il fait moins vingt!","Au revoir!","Je ne sais pas.","Bonjour."],correct:0,explain:"Oui, il fait moins vingt! = Yes, it's minus 20! Canadians LOVE weather small talk — engaging shows you fit in. 'Hein?' is a Quebec word like 'eh?' or 'right?'. Use it!",diff:3},
      {type:"order",prompt:"Build: It's beautiful today",words:["Il","fait","beau","aujourd'hui"],answer:["Il","fait","beau","aujourd'hui"],explain:"Il fait beau aujourd'hui! 'Faire beau' = to be nice weather. Use this on a sunny day — Canadians will smile and agree. Small talk starter for Spring/Summer!",diff:2},
      {type:"write",prompt:"Write 'It's snowing in Quebec'",accepted:["il neige au québec","il neige a québec","il neige au quebec","il neige à québec"],explain:"Il neige au Québec! Note: 'au' for masculine countries/regions. Au Canada, au Québec. 'À' for cities: à Montréal, à Toronto. Easy Canadian sentence!",diff:3}
    ]
  },
  {
    id:"f-14", title:"Body Parts & Going to the Doctor", unit:"Unit 5: Health & Body",
    mins:20, skill:"speaking", cefrTag:"Pre-A1", recap:["f-09","f-10"],
    teach:"Sooner or later you'll see a doctor in Canada. Maybe an emergency, maybe a checkup. The receptionist asks 'Qu'est-ce qui ne va pas?' — what's wrong? Today you learn body parts and how to describe pain in French. Knowing these words could save your life or help you communicate clearly when you need help most.",
    vocab:["la tête = head | les yeux = eyes","la bouche = mouth | les dents = teeth","la main = hand | le bras = arm","la jambe = leg | le pied = foot","le ventre = stomach | le dos = back","J'ai mal à... = It hurts... / I have pain in...","J'ai mal à la tête = I have a headache","J'ai mal au ventre = I have a stomachache"],
    questions:[
      {type:"tap",fr:"la tête",opts:["the hand","the head","the leg","the eye"],correct:1,explain:"La tête = the head! Pronounced 'la tet'. The accent on ê doesn't change pronunciation much but remember to write it. 'J'ai mal à la tête' = I have a headache.",diff:1},
      {type:"tap",fr:"le ventre",opts:["the back","the stomach","the chest","the leg"],correct:1,explain:"Le ventre = the stomach/belly! The 'official' medical word is 'l'estomac' but 'ventre' is much more common in everyday speech. 'J'ai mal au ventre' = stomachache.",diff:1},
      {type:"match",prompt:"Match body parts",pairs:[["la main","hand"],["le pied","foot"],["les yeux","eyes"],["le dos","back"],["les dents","teeth"]],explain:"Master these 5 body parts first — they cover most common pains and complaints at the doctor. 'Mal au dos' (back pain) is very common in Canadians!",diff:2},
      {type:"fill",before:"J'ai mal",blank:"___",after:"pied. (My foot hurts)",options:["à la","au","aux","à"],correct:1,explain:"Au pied! 'À + le' = au (for masculine). Pied is masculine, so 'au pied'. Pattern: J'ai mal au + masculine, J'ai mal à la + feminine, J'ai mal aux + plural.",diff:3},
      {type:"mcq",prompt:"At the doctor, you say 'J'ai mal aux yeux'. What's wrong?",options:["My ears hurt","My eyes hurt","My head hurts","My hand hurts"],correct:1,explain:"J'ai mal aux yeux = My eyes hurt! 'Aux' = à + les (used before plural nouns). Eyes are plural, so 'aux yeux'. Tip: yeux is irregular — singular 'oeil' (eye), plural 'yeux' (eyes).",diff:2},
      {type:"scene",story:"At Hôpital Sainte-Justine in Montréal, the nurse asks your child: 'Où est-ce que ça fait mal?' The child has a headache.",prompt:"What's the answer?",options:["J'ai mal à la tête","J'ai mal au pied","Je suis malade","Je ne sais pas"],correct:0,explain:"J'ai mal à la tête = I have a headache. Tête is feminine, so 'à la tête'. The nurse asks 'where does it hurt?' — answering correctly speeds up treatment!",diff:2},
      {type:"order",prompt:"Build: I have a stomachache",words:["J'ai","mal","au","ventre"],answer:["J'ai","mal","au","ventre"],explain:"J'ai mal au ventre! Stomach (ventre) is masculine, so 'au'. This phrase works at the pharmacy, doctor, or with anyone offering food you can't eat right now.",diff:2},
      {type:"write",prompt:"Write 'My back hurts' in French (back = dos, masculine)",accepted:["j'ai mal au dos","mal au dos","j'ai mal a dos"],explain:"J'ai mal au dos! Common complaint among adults. The receptionist might ask 'depuis quand?' (since when?) — answer with 'depuis hier' (since yesterday) or 'depuis une semaine' (since a week).",diff:3}
    ]
  },
  {
    id:"f-15", title:"Common Quebec Expressions", unit:"Unit 5: Quebec Culture",
    mins:15, skill:"listening", cefrTag:"Pre-A1", recap:["f-09","f-10"],
    teach:"Quebec French has its own flavor — different from France French. Locals use special expressions you won't find in textbooks. Knowing these makes you sound less like a tourist and more like someone who actually lives in Quebec. Today you learn 8 essential Quebec expressions that will instantly elevate your French.",
    vocab:["Allô! = Hi! / Hello! (informal Quebec greeting)","Bienvenue = You're welcome (Quebec only — France uses 'de rien')","C'est correct = It's fine / OK","Pantoute = Not at all (very Quebec)","Magasiner = To shop (Quebec verb)","Tabarnak = (mild swear, very Quebec — careful!)","Char = Car (informal Quebec, like 'voiture')","Dépanneur = Convenience store (Quebec word)"],
    questions:[
      {type:"tap",fr:"un dépanneur",opts:["a restaurant","a convenience store","a gas station","a pharmacy"],correct:1,explain:"Un dépanneur = a convenience store! In France they say 'épicerie' but in Quebec it's ALWAYS dépanneur. Found on every street corner. Beer, milk, lottery tickets, snacks. You'll use this word weekly!",diff:1},
      {type:"tap",fr:"magasiner",opts:["to drive","to eat","to shop","to read"],correct:2,explain:"Magasiner = to shop (Quebec verb)! In France they say 'faire des courses' or 'faire les magasins'. In Quebec, you 'magasine'. 'Je vais magasiner' = I'm going shopping.",diff:1},
      {type:"match",prompt:"Match Quebec expression to meaning",pairs:[["Allô","Hi (informal)"],["C'est correct","It's fine"],["un char","a car (informal)"],["pantoute","not at all"],["bienvenue","you're welcome"]],explain:"These expressions are pure Quebec! Use them to sound local. 'Char' instead of 'voiture' shows you're integrated. 'Pantoute' is uniquely Québécois — you'll never hear it in France!",diff:2},
      {type:"fill",before:"Mon ami a dit 'merci' et j'ai répondu",blank:"___",after:"! (You're welcome — Quebec way)",options:["bonjour","de rien","bienvenue","au revoir"],correct:2,explain:"Bienvenue! In Quebec, 'bienvenue' means 'you're welcome' (response to merci). In France 'bienvenue' only means 'welcome'. This is one of the biggest differences — get it right!",diff:2},
      {type:"mcq",prompt:"A friend in Montreal asks 'As-tu aimé ça?' (Did you like it?). You really enjoyed it. The very Quebec answer is:",options:["Oui, c'est correct","Non, pantoute","Oui, j'ai bien aimé!","Bonjour"],correct:2,explain:"Oui, j'ai bien aimé! = Yes, I really liked it! 'C'est correct' just means 'OK' — too neutral. Quebecers love hearing enthusiasm. Use 'j'aime', 'j'adore', 'c'est super' for positive responses.",diff:2},
      {type:"scene",story:"A Quebec friend invites you over: 'Viens-tu chez nous samedi soir?' You accept enthusiastically.",prompt:"Quebec-style positive answer:",options:["Oui certainement, merci de l'invitation!","Non, pantoute","Bonjour","Au revoir"],correct:0,explain:"Oui certainement, merci de l'invitation! = Yes definitely, thanks for the invitation! Polite, warm, Quebec-appropriate. 'Pantoute' means 'not at all' — wrong here!",diff:3},
      {type:"order",prompt:"Build: I'm going shopping at the convenience store",words:["Je","vais","magasiner","au","dépanneur"],answer:["Je","vais","magasiner","au","dépanneur"],explain:"Je vais magasiner au dépanneur! Two pure Quebec words in one sentence: magasiner (to shop) + dépanneur (convenience store). You sound like a Montrealer!",diff:3},
      {type:"write",prompt:"Write the Quebec way to say 'You're welcome'",accepted:["bienvenue","de rien","ça fait plaisir"],explain:"Bienvenue! That's the Quebec way. France says 'de rien' or 'je vous en prie'. Quebec keeps it warm with 'bienvenue'. Use this and Quebecers will smile!",diff:2}
    ]
  },
  {
    id:"f-16", title:"At the Pharmacy", unit:"Unit 5: Health & Body",
    mins:20, skill:"speaking", cefrTag:"Pre-A1", recap:["f-09","f-14"],
    teach:"Pharmacies in Quebec (Jean Coutu, Pharmaprix, Uniprix) are everywhere and pharmacists give advice without an appointment. You can describe symptoms and get over-the-counter medication. Today you learn the exact phrases for asking for medicine, painkillers, and basic advice — all the way through to paying. After this lesson you can handle minor health needs solo.",
    vocab:["la pharmacie = pharmacy","un médicament = a medication","une ordonnance = a prescription","des comprimés = tablets/pills","un sirop = syrup","un pansement = bandage","Avez-vous quelque chose pour...? = Do you have something for...?","une douleur = a pain | la fièvre = fever"],
    questions:[
      {type:"tap",fr:"un médicament",opts:["a doctor","a medication","a hospital","a fever"],correct:1,explain:"Un médicament = a medication! Pronounced 'meh-dee-kah-MAHN'. Different from English 'medicine'. The pharmacist will use this word constantly. 'Ce médicament est en vente libre' = This medication is over-the-counter.",diff:1},
      {type:"tap",fr:"une ordonnance",opts:["a pharmacy","a prescription","a tablet","a fever"],correct:1,explain:"Une ordonnance = a prescription. The pharmacist will ask 'Avez-vous une ordonnance?'. If yes, you hand it over. If no, you ask for advice. Memorize this word — comes up at every pharmacy visit!",diff:2},
      {type:"match",prompt:"Match pharmacy items",pairs:[["des comprimés","tablets"],["un sirop","syrup"],["un pansement","bandage"],["une ordonnance","prescription"],["la fièvre","fever"]],explain:"These 5 items cover 90% of pharmacy visits. Master them and you can navigate any Quebec pharmacy. Tip: Tylenol is the brand name even in French!",diff:2},
      {type:"fill",before:"Avez-vous quelque chose pour",blank:"___",after:"de tête? (Do you have something for headache?)",options:["la douleur","le mal","une fièvre","un ventre"],correct:1,explain:"Mal de tête = headache (literally 'pain of head'). Pattern: 'mal de [body part]'. Mal de gorge = sore throat. Mal de dos = back pain. Pharmacists hear this question 100 times a day!",diff:3},
      {type:"mcq",prompt:"You ask the pharmacist for painkillers. The most common request is:",options:["Donnez-moi du Tylenol!","Avez-vous des comprimés contre la douleur?","Médicament fort","Bonjour"],correct:1,explain:"Avez-vous des comprimés contre la douleur? = Do you have painkiller tablets? Polite, clear, lets the pharmacist recommend the right one. 'Contre la douleur' = against pain. Better than just naming brands!",diff:3},
      {type:"scene",story:"Your child has a fever (38°C). At Jean Coutu, you approach the pharmacist.",prompt:"What do you say?",options:["Bonjour, mon enfant a de la fièvre. Pouvez-vous me conseiller?","Médicament!","Je ne sais pas","Au revoir"],correct:0,explain:"Bonjour, mon enfant a de la fièvre. Pouvez-vous me conseiller? = Hello, my child has a fever. Can you advise me? Polite, clear, lets pharmacist help. They might recommend Tempra or children's Tylenol. Excellent communication!",diff:3},
      {type:"order",prompt:"Build: Where are the painkillers?",words:["Où","sont","les","comprimés","contre","la","douleur?"],answer:["Où","sont","les","comprimés","contre","la","douleur?"],explain:"Où sont les comprimés contre la douleur? = Where are the painkiller tablets? 'Où' = where, 'sont' = are. The pharmacist will point you to the right aisle. Saves time!",diff:3},
      {type:"write",prompt:"Write 'I have a sore throat' (mal de gorge)",accepted:["j'ai mal à la gorge","j'ai mal a la gorge","mal de gorge","j'ai un mal de gorge"],explain:"J'ai mal à la gorge! 'Gorge' (throat) is feminine = 'à la gorge'. The pharmacist might suggest lozenges (pastilles) or syrup (sirop). Now you can ask for help!",diff:3}
    ]
  },
  {
    id:"f-17", title:"Asking Directions", unit:"Unit 6: Getting Around",
    mins:20, skill:"speaking", cefrTag:"Pre-A1", recap:["f-09"],
    teach:"You're lost in downtown Montreal. Your GPS died. You need to find the metro, your hotel, or a specific street. Today you learn how to ASK directions politely AND understand the ANSWERS. Direction phrases use simple words but specific patterns. Master them and you'll never be lost in any French city.",
    vocab:["Où est...? = Where is...?","Comment aller à...? = How do I get to...?","tout droit = straight ahead","à gauche = to the left | à droite = to the right","tournez = turn | continuez = continue","à côté de = next to | en face de = across from","près d'ici = near here | loin = far","la rue = street | l'avenue = avenue"],
    questions:[
      {type:"tap",fr:"à gauche",opts:["to the right","to the left","straight","stop"],correct:1,explain:"À gauche = to the left! Pronounced 'ah gohsh'. Easy memory: 'gauche' sounds like 'gosh' and starts with G like 'go-left'. You'll use this constantly when navigating!",diff:1},
      {type:"tap",fr:"tout droit",opts:["turn right","turn left","straight ahead","stop here"],correct:2,explain:"Tout droit = straight ahead! Confusing because 'droit' alone means 'right'. But 'tout droit' = straight. Pronounced 'too DRWAH'. Listen for the 'tout' to know it's straight, not right!",diff:2},
      {type:"match",prompt:"Match direction words",pairs:[["tournez","turn"],["continuez","continue"],["à droite","to the right"],["en face","across from"],["près","near"]],explain:"These 5 words let you understand any directions. 'Tournez à droite, puis continuez tout droit' = Turn right, then continue straight. Practice listening for these!",diff:2},
      {type:"fill",before:"La banque est",blank:"___",after:"de la pharmacie. (The bank is across from the pharmacy)",options:["à côté","en face","près","loin"],correct:1,explain:"En face de = across from / facing. 'À côté de' = next to (beside). Two different things! 'En face de la pharmacie' = directly across from the pharmacy.",diff:3},
      {type:"mcq",prompt:"A stranger gives you directions: 'Tournez à gauche au coin, puis continuez tout droit pendant deux rues'. What did they say?",options:["Turn left at the corner, then continue straight for 2 blocks","Turn right then walk for 2 minutes","Go straight then left after 2 corners","Stop here and wait"],correct:0,explain:"Tournez à gauche au coin (turn left at the corner), continuez tout droit (continue straight), pendant deux rues (for two streets/blocks). Real Quebec direction-giving — now you can actually understand it!",diff:3},
      {type:"scene",story:"You're looking for the metro Berri-UQAM in Montreal. You ask a stranger.",prompt:"What's the polite way to ask?",options:["Excusez-moi, où est le métro Berri-UQAM s'il vous plaît?","Métro!","Bonjour","Comment ça va?"],correct:0,explain:"Excusez-moi, où est le métro Berri-UQAM s'il vous plaît? — Polite, complete, gets you a clear answer. Always start with 'Excusez-moi' and end with 's'il vous plaît'. Quebecers will gladly help!",diff:2},
      {type:"order",prompt:"Build the question: How do I get to Old Montreal?",words:["Comment","aller","au","Vieux-Montréal?"],answer:["Comment","aller","au","Vieux-Montréal?"],explain:"Comment aller au Vieux-Montréal? = How do I get to Old Montreal? 'Comment aller à' for cities, 'au' for masculine destinations. Vieux-Montréal is a beautiful tourist area worth visiting!",diff:3},
      {type:"write",prompt:"Write 'It is on the right' in French",accepted:["c'est à droite","c'est a droite","à droite","a droite"],explain:"C'est à droite! Or just 'À droite!' for short. Quebecers often say 'C'est juste à droite' (It's just to the right) or 'C'est sur votre droite' (It's on your right). All work!",diff:3}
    ]
  },
  {
    id:"f-18", title:"At the Café & Restaurant", unit:"Unit 6: Getting Around",
    mins:20, skill:"speaking", cefrTag:"Pre-A1", recap:["f-09"],
    teach:"Quebec has incredible café and restaurant culture. Tim Hortons, Second Cup, local bistros — all in French. Ordering a coffee, asking for the menu, paying the bill — basic things, but you need the right phrases. Today you learn the cafe/restaurant vocabulary that makes every meal smooth and enjoyable.",
    vocab:["un café = a coffee","un thé = a tea","une bière = a beer","de l'eau = water","la carte / le menu = menu","l'addition = the bill","Je voudrais... = I would like...","Pour ici ou pour emporter? = For here or to go?"],
    questions:[
      {type:"tap",fr:"un café",opts:["a tea","a coffee","a juice","a beer"],correct:1,explain:"Un café = a coffee! Quebec runs on coffee. Tim Hortons is a national institution. 'Un café s'il vous plaît' is the most ordered drink in the country!",diff:1},
      {type:"tap",fr:"l'addition",opts:["the menu","the bill","the waiter","the table"],correct:1,explain:"L'addition = the bill / check. At the end of the meal, ask 'L'addition s'il vous plaît' — the waiter brings it. In Quebec you usually flag the waiter for the bill rather than wait.",diff:1},
      {type:"match",prompt:"Match café/restaurant items",pairs:[["la carte","menu"],["l'addition","the bill"],["un café","a coffee"],["de l'eau","water"],["une bière","a beer"]],explain:"5 essentials for any restaurant visit! 'La carte' is the menu (different from a literal card). 'De l'eau' = water — always free in Quebec restaurants if you ask!",diff:2},
      {type:"fill",before:"Je",blank:"___",after:"un café et un croissant. (I would like a coffee and a croissant)",options:["veux","voudrais","prends","mange"],correct:1,explain:"Voudrais! 'Je voudrais' = I would like (polite). 'Je veux' = I want (less polite). ALWAYS use 'voudrais' when ordering — sounds polite and educated. Locals will appreciate it.",diff:2},
      {type:"mcq",prompt:"At Tim Hortons, the cashier asks 'Pour ici ou pour emporter?'. What did they ask?",options:["For here or to go?","How are you?","Big or small?","Hot or cold?"],correct:0,explain:"Pour ici ou pour emporter? = For here or to go? Pour ici = eat here. Pour emporter = take away. Asked at every coffee shop. Reply: 'Pour emporter, s'il vous plaît' or 'Pour ici, merci'.",diff:2},
      {type:"scene",story:"At a downtown Montreal café, you sit down. The waiter brings you the menu and asks 'Qu'est-ce que je vous sers?' (What can I serve you?). You want a black coffee and a croissant.",prompt:"Polite order:",options:["Café et croissant.","Je voudrais un café noir et un croissant, s'il vous plaît.","Coffee!","Bonjour."],correct:1,explain:"Je voudrais un café noir et un croissant, s'il vous plaît! = I would like a black coffee and a croissant, please. Polite, clear, complete. The waiter will smile and bring exactly what you ordered!",diff:3},
      {type:"order",prompt:"Build: The bill please!",words:["L'addition","s'il","vous","plaît!"],answer:["L'addition","s'il","vous","plaît!"],explain:"L'addition s'il vous plaît! In Quebec restaurants, the bill rarely comes automatically — you ASK for it. Make eye contact with the server and use this phrase. They'll bring it within a minute!",diff:2},
      {type:"write",prompt:"Write 'I would like water please' in French",accepted:["je voudrais de l'eau","je voudrais de l'eau s'il vous plaît","de l'eau s'il vous plaît","de l'eau"],explain:"Je voudrais de l'eau s'il vous plaît! Tap water is FREE everywhere in Quebec — just ask. 'De l'eau' is the right way to say water (with the article 'de l'). Restaurants happily oblige!",diff:3}
    ]
  },
  {
    id:"f-19", title:"Metro, Bus & Getting Around Montreal", unit:"Unit 6: Getting Around",
    mins:20, skill:"reading", cefrTag:"Pre-A1", recap:["f-17"],
    teach:"Montreal has one of the best metro systems in North America — and a busy bus network. To get around without a car, you need to navigate it in French. Today you learn metro/bus vocabulary, how to ask which line, and key phrases for buying tickets. After this you can confidently use the STM (Société de Transport de Montréal).",
    vocab:["le métro = the subway/metro","l'autobus = the bus","la station = the station","l'arrêt = the stop","un billet = a ticket","une carte OPUS = transit card","Quelle ligne? = Which line?","Quelle direction? = Which direction?"],
    questions:[
      {type:"tap",fr:"le métro",opts:["the bus","the subway","the train","the taxi"],correct:1,explain:"Le métro = the subway/metro! 4 lines in Montreal: orange, green, blue, yellow. Pronounced 'meh-TROH'. Quebecers use métro constantly — fast, cheap, mostly underground.",diff:1},
      {type:"tap",fr:"un arrêt",opts:["a station","a stop","a ticket","a line"],correct:1,explain:"Un arrêt = a stop (bus stop). Different from 'station' (metro station). 'L'arrêt d'autobus' = the bus stop. You'll see this word at every bus shelter.",diff:1},
      {type:"match",prompt:"Match transit vocabulary",pairs:[["le métro","subway"],["l'autobus","bus"],["la station","station"],["un billet","ticket"],["la carte OPUS","transit card"]],explain:"All Montreal transit basics. The OPUS card is rechargeable — works on metro and buses. Available at any metro station for $6 plus credit.",diff:2},
      {type:"fill",before:"Pour aller à Berri-UQAM, je prends",blank:"___",after:"orange. (I take the orange line)",options:["la","le","une","du"],correct:0,explain:"La ligne orange! Ligne is feminine = 'la ligne'. Montreal has 4 colored lines. The orange line passes through downtown. Knowing this saves you from getting lost!",diff:3},
      {type:"mcq",prompt:"At the metro ticket booth, you ask: 'Combien coûte un billet?' What did you ask?",options:["Where is the ticket?","How much is a ticket?","What time is it?","Can I have a ticket?"],correct:1,explain:"Combien coûte un billet? = How much is a ticket? In 2026, Montreal metro is $3.75 per single ticket. The OPUS card is cheaper for frequent users. Ask about prices openly!",diff:2},
      {type:"scene",story:"Inside a metro station, you ask a stranger for directions to McGill: 'Excusez-moi, c'est quelle direction pour McGill?'",prompt:"Likely correct response:",options:["Direction Côte-Vernon!","Direction Côte-Vertu sur la ligne orange.","Direction West-Island.","Au revoir."],correct:1,explain:"Direction Côte-Vertu sur la ligne orange! Each metro train has a 'direction' (the end station). For McGill: take orange line direction Côte-Vertu. Exit at McGill station. Perfect Montreal navigation!",diff:3},
      {type:"order",prompt:"Build: Where is the metro station?",words:["Où","est","la","station","de","métro?"],answer:["Où","est","la","station","de","métro?"],explain:"Où est la station de métro? = Where is the metro station? 'Station de métro' is THE phrase. Every Montrealer knows where the nearest one is — they'll point you straight there.",diff:2},
      {type:"write",prompt:"Write 'I would like to buy a ticket' in French",accepted:["je voudrais acheter un billet","acheter un billet","je voudrais un billet","un billet s'il vous plaît"],explain:"Je voudrais acheter un billet! 'Acheter' = to buy. Or simpler: 'Je voudrais un billet' (I would like a ticket). Both work at the ticket booth or at the kiosk. Easy daily transaction!",diff:3}
    ]
  },
  {
    id:"f-20", title:"Foundation Review & Real Conversation", unit:"Unit 6: Getting Around",
    mins:25, skill:"mixed", cefrTag:"Pre-A1", recap:["f-15","f-16","f-17","f-18","f-19"],
    teach:"You've learned the foundation: greetings, numbers, time, dates, family, weather, body, pharmacy, directions, café, transit. Today's lesson stitches it all together with REAL conversation scenarios. Each question is a slice of daily life in Quebec — and you'll show yourself how much French you can actually use. By the end you'll feel ready for A1.",
    vocab:["Bonjour, comment allez-vous? = Hello, how are you?","Très bien, merci, et vous? = Very well, thank you, and you?","Pouvez-vous m'aider? = Can you help me?","À quelle heure...? = At what time...?","Combien ça coûte? = How much does it cost?","Je cherche... = I'm looking for...","C'est où? = Where is it?","Bonne journée! = Have a good day!"],
    questions:[
      {type:"tap",fr:"Très bien, merci",opts:["Goodbye","Very well, thanks","Help me","Excuse me"],correct:1,explain:"Très bien, merci = Very well, thank you! Standard polite response to 'Comment allez-vous?'. 'Très bien' = very well. Always add 'merci' to be warm. 'Et vous?' to return the question!",diff:1},
      {type:"tap",fr:"Je cherche",opts:["I am late","I have","I am looking for","I am tired"],correct:2,explain:"Je cherche = I'm looking for. Useful in stores, on streets, at offices. 'Je cherche le métro' = I'm looking for the metro. Pronounced 'zhuh shersh'. Memorize it!",diff:1},
      {type:"match",prompt:"Match the everyday phrase",pairs:[["Bonjour!","Hello!"],["Merci beaucoup","Thank you very much"],["Au revoir","Goodbye"],["Excusez-moi","Excuse me"],["S'il vous plaît","Please"]],explain:"These 5 phrases are 80% of daily polite interactions in Quebec! Master them and you'll feel comfortable in any social situation.",diff:1},
      {type:"fill",before:"Au métro, je",blank:"___",after:"un billet. (I buy a ticket)",options:["mange","achète","prends","cherche"],correct:1,explain:"J'achète un billet! 'Acheter' = to buy. 'Achète' is conjugated for je (I). Common verb at every store/transit station. Practice: j'achète, tu achètes, il/elle achète.",diff:2},
      {type:"mcq",prompt:"You're at Jean Coutu (pharmacy). The pharmacist asks 'Avez-vous une ordonnance?'. You don't have one — you just want headache medicine.",options:["Oui, voici!","Non, mais j'ai mal à la tête. Avez-vous quelque chose?","Au revoir","Pourquoi?"],correct:1,explain:"Non, mais j'ai mal à la tête. Avez-vous quelque chose? = No, but I have a headache. Do you have something? Pharmacist will recommend Tylenol or Advil. You handled this entirely in French!",diff:3},
      {type:"scene",story:"Real-life test: You meet a Quebec friend at a café. Greet, order, pay, say goodbye — all in French. The friend says 'Salut!'.",prompt:"Most natural response:",options:["Salut! Comment ça va?","Bonjour Madame!","Au revoir!","Pardon!"],correct:0,explain:"Salut! Comment ça va? Informal greeting back, asking how they are. 'Salut' is for friends/casual situations. 'Comment ça va?' is more casual than 'comment allez-vous?'. Perfect for friends!",diff:2},
      {type:"order",prompt:"Build the conversation closer: Have a good day, see you soon!",words:["Bonne","journée,","à","bientôt!"],answer:["Bonne","journée,","à","bientôt!"],explain:"Bonne journée, à bientôt! = Have a good day, see you soon! Warm Quebec way to say goodbye. 'À bientôt' = see you soon. Use with friends, colleagues, anyone you'll meet again.",diff:2},
      {type:"write",prompt:"Write a complete polite request: 'Excuse me, where is the metro please?'",accepted:["excusez-moi, où est le métro s'il vous plaît","excusez-moi où est le métro","excusez-moi, où est le metro","où est le métro"],explain:"Excusez-moi, où est le métro s'il vous plaît? — perfect polite question that you'd actually use. You've completed Foundation! You can navigate basic French Canadian life. Ready for A1!",diff:3}
    ]
  },
];


const A1_LESSONS = [
  mkL("a1-01","At the Grocery Store",25,"speaking",
    "You walk into IGA or Metro — Quebec's biggest grocery stores. Everything is in French! The signs, the labels, the cashier. Today you learn how to navigate grocery shopping completely in French. This comes up every single week of your life in Canada. After this lesson you can find what you need, ask for help, and pay — all in French.",
    ["les légumes = vegetables","les fruits = fruits","la viande = meat","le pain = bread","le lait = milk","les oeufs = eggs","Où sont les...? = Where are the...?","Combien ça coûte? = How much does it cost?","Je voudrais... = I would like...","C'est tout = That's all"],
    [mcq("You need milk. You ask:",["Où sont les oeufs?","Où est le lait?","Je voudrais du pain","Combien ça coûte?"],1,"Où est le lait? = Where is the milk? Lait = milk. Always use 'où est' for single items and 'où sont' for plural items. The staff will point you right to it!",1),
     mcq("The cashier asks 'C'est tout?' What does this mean?",["How are you?","Is that everything?","How much?","Do you have a card?"],1,"C'est tout? = Is that everything? / That's all? You will hear this at EVERY checkout in Quebec. Reply 'Oui c'est tout' or just 'Oui merci'!",1),
     {type:"match",prompt:"Match the French food item to English",pairs:[["le lait","milk"],["le pain","bread"],["les oeufs","eggs"],["la viande","meat"],["les légumes","vegetables"]],explain:"These 5 items are in every shopping cart! Learn them and you can read any grocery list or recipe in French.",diff:1},
     {type:"fill",before:"Excusez-moi, où sont",blank:"___",after:"s'il vous plaît? (Where are the vegetables?)",options:["le lait","les légumes","la viande","le pain"],correct:1,explain:"Où sont les légumes? = Where are the vegetables? Use 'les' for plural items and 'le/la' for singular. Les légumes, les fruits, les oeufs — all plural!",diff:2},
     mcq("How do you politely ask for something in French?",["Je veux du pain","Je voudrais du pain s'il vous plaît","Donnez-moi du pain","Pain s'il vous plaît"],1,"Je voudrais = I would like (conditional tense — polite form). Much more polite than 'je veux' which means I want. Always use 'je voudrais' in stores and restaurants!",2),
     {type:"scene",story:"Amara is at IGA. She needs eggs but can't find them. A store employee walks by.",prompt:"What should Amara say?",options:["Excusez-moi, où sont les oeufs s'il vous plaît?","Je veux oeufs!","Où est le oeufs?","Donnez-moi les oeufs"],correct:0,explain:"Excusez-moi, où sont les oeufs s'il vous plaît? Perfect! Excusez-moi to get attention, où sont for plural items, s'il vous plaît for politeness. This works in any Quebec store!",diff:2},
     {type:"order",prompt:"Build the sentence: I would like some bread please",words:["Je","voudrais","du","pain","s'il","vous","plaît"],answer:["Je","voudrais","du","pain","s'il","vous","plaît"],explain:"Je voudrais du pain s'il vous plaît — perfect polite request! Du = some (partitive article for masculine nouns). Je voudrais de la viande, du lait, du pain.",diff:2},
     wr("Write how you ask where the milk is in French",["où est le lait","ou est le lait","où est le lait s'il vous plaît"],"Où est le lait? Simple and perfect! Lait is masculine so use 'le'. Où est le lait s'il vous plaît adds politeness. You are ready to shop in any Quebec grocery store!",2)]),

  mkL("a1-02","At the Pharmacy",25,"speaking",
    "Getting sick in Canada and not knowing French is scary. But with today's vocabulary, you can walk into any Pharmaprix or Jean Coutu — Quebec's most common pharmacies — explain your symptoms, understand the pharmacist, and get the right medicine. This lesson is important. It could make a real difference when you need help.",
    ["J'ai mal à... = I have pain in/at...","J'ai de la fièvre = I have a fever","une ordonnance = a prescription","un médicament = a medicine/medication","une allergie = an allergy","Je suis allergique à... = I am allergic to...","Ça fait combien de temps? = How long has it been?","depuis hier = since yesterday","deux fois par jour = twice a day","Avez-vous...? = Do you have...?"],
    [mcq("You have a headache. You say:",["J'ai mal à la tête","J'ai mal au ventre","J'ai de la fièvre","Je suis allergique"],0,"J'ai mal à la tête = I have a headache (literally I have pain at the head). J'ai mal au dos = back pain, J'ai mal à la gorge = sore throat. This pattern works for any body part!",1),
     mcq("The pharmacist asks for your ordonnance. What do they want?",["Your health card","Your prescription","Your allergies","Your address"],1,"Une ordonnance = a prescription! The pharmacist needs it to give you certain medications. Always bring your ordonnance from the doctor. In Quebec this is required for many medicines.",1),
     {type:"match",prompt:"Match the symptom to English",pairs:[["J'ai de la fièvre","I have a fever"],["J'ai mal à la gorge","I have a sore throat"],["Je suis allergique","I am allergic"],["une ordonnance","a prescription"],["deux fois par jour","twice a day"]],explain:"These phrases will help you communicate with any pharmacist or doctor in Canada. Knowing them could make a real difference to your health!",diff:1},
     {type:"fill",before:"Je suis allergique",blank:"___",after:"la pénicilline. (I am allergic to penicillin)",options:["à","de","au","en"],correct:0,explain:"Je suis allergique à = I am allergic to. Always followed by à (or au/aux/à la depending on the noun). Je suis allergique au gluten, à la pénicilline, aux noix. Very important to know!",diff:2},
     mcq("The pharmacist says 'Prenez un comprimé deux fois par jour'. What should you do?",["Take one tablet once a day","Take two tablets twice a day","Take one tablet twice a day","Take two tablets once a day"],2,"Prenez = take (formal command), un comprimé = one tablet, deux fois par jour = twice a day. So: one tablet, twice daily. Understanding dosage instructions is crucial for your health!",2),
     {type:"scene",story:"Ravi wakes up with a fever and sore throat. He goes to Pharmaprix. The pharmacist asks 'Qu'est-ce qui ne va pas?' (What's wrong?)",prompt:"What should Ravi say?",options:["J'ai de la fièvre et j'ai mal à la gorge","Je suis une ordonnance","J'ai mal une pharmacie","Deux fois par jour merci"],correct:0,explain:"J'ai de la fièvre et j'ai mal à la gorge — perfect! Two symptoms clearly explained. The pharmacist now knows exactly what to recommend. You just had a real medical conversation in French!",diff:2},
     {type:"order",prompt:"Build: I have had a sore throat since yesterday",words:["J'ai","mal","à","la","gorge","depuis","hier"],answer:["J'ai","mal","à","la","gorge","depuis","hier"],explain:"J'ai mal à la gorge depuis hier — since yesterday. Depuis = since/for. Depuis hier = since yesterday, depuis 3 jours = for 3 days. Ça fait combien de temps? = How long has it been?",diff:3},
     wr("Write how you tell a pharmacist you have a fever",["j'ai de la fièvre","j'ai fièvre","j'ai une fièvre","de la fièvre"],"J'ai de la fièvre! Note the 'de la' before fièvre — this is the partitive article. You have now mastered one of the most important health phrases for life in Canada!",2)]),

  mkL("a1-03","Getting Around Montreal",25,"listening",
    "You need to take the STM bus or metro to work. The driver announces stops in French. Your phone GPS speaks French. Someone gives you directions and you have no idea where to go. Today we fix all of that. You will learn directions, transit vocabulary, and how to ask for help when you're lost — essential skills for any Canadian city.",
    ["à gauche = to the left","à droite = to the right","tout droit = straight ahead","tournez = turn","prenez = take","le métro = the metro/subway","l'arrêt = the stop","la station = the station","Où est...? = Where is...?","Comment aller à...? = How do I get to...?"],
    [mcq("Someone says 'Tournez à gauche'. What do you do?",["Turn right","Go straight","Turn left","Take the metro"],2,"Tournez à gauche = Turn left! Gauche = left. Droite = right. Tout droit = straight. These 3 direction words will get you anywhere in Quebec. Tournez à droite = turn right.",1),
     mcq("You're on the metro. The announcer says 'Prochain arrêt: Berri-UQAM'. What is happening?",["The metro is stopping","The next stop is Berri-UQAM","The metro is turning left","You need to transfer"],1,"Prochain arrêt = next stop! You will hear this on every STM bus and metro in Montreal. Prochain = next, arrêt = stop. Essential for not missing your station!",1),
     {type:"match",prompt:"Match the direction word to English",pairs:[["à gauche","left"],["à droite","right"],["tout droit","straight ahead"],["tournez","turn"],["prenez","take"]],explain:"These 5 words are all you need to follow directions anywhere in Canada. Left, right, straight, turn, take — master them and you'll never get truly lost!",diff:1},
     {type:"fill",before:"Pour aller à la station, prenez le bus puis tournez",blank:"___",after:"au feu rouge.",options:["à gauche","à droite","tout droit","en bas"],correct:0,explain:"Prenez le bus puis tournez à gauche au feu rouge = Take the bus then turn left at the red light. Au feu rouge = at the red light. Un très bon repère (landmark) to use in directions!",diff:2},
     mcq("How do you ask 'How do I get to the airport?'",["Où est l'aéroport?","Comment aller à l'aéroport?","Prenez l'aéroport","À gauche l'aéroport"],1,"Comment aller à...? = How do I get to...? Comment = how, aller = to go. Comment aller à l'aéroport? Comment aller au centre-ville? Works for any destination!",2),
     {type:"scene",story:"Sara is lost in Montreal. She stops someone and says 'Excusez-moi, comment aller à la station de métro?' The person replies 'Allez tout droit, puis tournez à droite au coin de la rue.'",prompt:"What should Sara do?",options:["Go straight then turn right at the corner","Turn left then go straight","Take the metro then turn right","Go straight to the corner then turn left"],correct:0,explain:"Allez tout droit = go straight, puis = then, tournez à droite = turn right, au coin de la rue = at the street corner. You just understood real French directions! Sara will find her metro!",diff:2},
     {type:"order",prompt:"Ask how to get to downtown",words:["Comment","aller","au","centre-ville?"],answer:["Comment","aller","au","centre-ville?"],explain:"Comment aller au centre-ville? Au = à + le (contraction for masculine nouns). À la gare, au centre-ville, à l'hôpital. Centre-ville = downtown — a word you'll use constantly in any Canadian city!",diff:2},
     wr("Write how you ask where the metro station is",["où est la station de métro","où est le métro","où est la station","comment aller au métro"],"Où est la station de métro? Perfect! This question will help you navigate any Canadian city. The STM app also has French audio — now you'll understand it!",2)]),

  mkL("a1-04","Your First Job Interview",30,"speaking",
    "Getting a job is one of the most important steps for immigrants in Canada. Even entry-level jobs often require basic French in Quebec. Today you learn the exact phrases used in French job interviews — how to introduce yourself professionally, talk about your experience, and ask questions. These phrases have helped thousands of immigrants get their first Canadian job.",
    ["Je m'appelle... et je postule pour = My name is... and I am applying for","J'ai X années d'expérience = I have X years of experience","Je parle... = I speak...","Mes points forts sont... = My strengths are...","Je suis disponible = I am available","Quel est le salaire? = What is the salary?","Quand commencerais-je? = When would I start?","Je suis très motivé(e) = I am very motivated","Merci de votre temps = Thank you for your time","Avez-vous des questions? = Do you have any questions?"],
    [mcq("The interviewer asks 'Parlez-moi de vous'. What do they want?",["Tell them your address","Tell them about yourself","Tell them about your friends","Tell them your salary expectations"],1,"Parlez-moi de vous = Tell me about yourself. The most common opening in any French interview! Start with: Je m'appelle X, j'ai X ans, je viens de X, j'ai X années d'expérience en...",1),
     mcq("How do you say 'I have 3 years of experience'?",["J'ai 3 ans d'expérience","Je suis 3 années","J'habite 3 ans expérience","J'ai expérience 3"],0,"J'ai 3 ans d'expérience = I have 3 years of experience! Notice: ans d'expérience. The d' (de + vowel) links them. J'ai 5 ans d'expérience en comptabilité = 5 years in accounting.",1),
     {type:"match",prompt:"Match interview phrases to their meaning",pairs:[["Je suis disponible","I am available"],["Mes points forts","My strengths"],["Je suis motivé","I am motivated"],["Merci de votre temps","Thank you for your time"],["Avez-vous des questions?","Do you have questions?"]],explain:"These 5 phrases appear in almost every French job interview. Learn them and you'll sound professional and prepared — exactly what employers want!",diff:1},
     {type:"fill",before:"J'ai cinq",blank:"___",after:"d'expérience en restauration.",options:["ans","jours","heures","mois"],correct:0,explain:"J'ai cinq ans d'expérience = I have five years of experience. Ans = years. Mois = months. Jours = days. Always use 'ans' for years of experience in a job context!",diff:2},
     mcq("The interviewer asks 'Pourquoi voulez-vous travailler ici?' (Why do you want to work here?) What is a good answer?",["Je ne sais pas","J'ai besoin d'argent","Je suis très motivé et votre entreprise m'intéresse beaucoup","C'est près de chez moi"],2,"Je suis très motivé et votre entreprise m'intéresse beaucoup = I am very motivated and your company interests me a lot. Always show enthusiasm! Mention something specific about the company if you can.",2),
     {type:"scene",story:"Priya is at her first job interview at a Montreal café. The manager asks 'Parlez-vous français?' (Do you speak French?)",prompt:"What is the best response?",options:["Je parle un peu français et j'apprends chaque jour","Non, pas du tout","Oui, très bien merci","Je ne comprends pas"],correct:0,explain:"Je parle un peu français et j'apprends chaque jour = I speak a little French and I learn every day. Honest, positive, and shows commitment! Employers in Quebec love this attitude.",diff:2},
     {type:"order",prompt:"Introduce yourself professionally: My name is Sara and I am applying for the position",words:["Je","m'appelle","Sara","et","je","postule","pour","le","poste"],answer:["Je","m'appelle","Sara","et","je","postule","pour","le","poste"],explain:"Je m'appelle Sara et je postule pour le poste — perfect professional introduction! Postule = apply (from postuler). Le poste = the position/job. Add the specific job title after: le poste de serveur, le poste de caissier.",diff:3},
     wr("Write how you say you are motivated and available to work",["je suis motivé","je suis disponible","je suis très motivé et disponible","motivé et disponible"],"Je suis très motivé(e) et disponible! These two words — motivé and disponible — are music to any employer's ears. You're ready for your first French job interview in Canada!",2)]),

  mkL("a1-05","At the Doctor",25,"mixed",
    "Going to a doctor in Quebec is different from what you know. You'll call a clinic, book an appointment in French, wait in a waiting room where everyone speaks French, and then explain your symptoms to a doctor who may speak only French. Today you learn exactly what to say — from booking the appointment to describing what's wrong and understanding the doctor's instructions.",
    ["J'ai besoin d'un rendez-vous = I need an appointment","C'est urgent = It's urgent","Depuis quand? = Since when?","J'ai des douleurs = I have pains","la tête = head","le ventre = stomach/belly","le dos = back","la gorge = throat","une radiographie = an X-ray","Je prends des médicaments = I take medications"],
    [mcq("You call a clinic. They ask 'C'est urgent?' What do they want to know?",["Your name","If it's an emergency","Your health card number","Your address"],1,"C'est urgent? = Is it urgent? If yes, say 'Oui c'est urgent' for same-day appointment. If no, say 'Non, pas vraiment' = No, not really. This determines how quickly you get seen!",1),
     mcq("The doctor asks 'Depuis quand avez-vous ces symptômes?' What is she asking?",["What symptoms do you have?","Since when do you have these symptoms?","Do you take medications?","Where is the pain?"],1,"Depuis quand = since when? Depuis quand avez-vous ces symptômes? = Since when have you had these symptoms? Reply: depuis hier (since yesterday), depuis 3 jours (for 3 days), depuis une semaine (for a week).",1),
     {type:"match",prompt:"Match the body part to English",pairs:[["la tête","head"],["le dos","back"],["la gorge","throat"],["le ventre","stomach"],["le bras","arm"]],explain:"Knowing body parts in French is essential for any medical appointment. J'ai mal à la tête, au dos, à la gorge, au ventre — now you can describe any pain to a doctor in Quebec!",diff:1},
     {type:"fill",before:"J'ai mal",blank:"___",after:"dos depuis trois jours.",options:["au","à la","à l'","aux"],correct:0,explain:"J'ai mal au dos = I have back pain. Au = à + le (for masculine nouns). À la tête (feminine), au dos (masculine), à l'épaule (vowel), aux pieds (plural). The article changes but the pattern is always 'j'ai mal à'!",diff:2},
     mcq("The doctor says 'Je vais vous prescrire des antibiotiques'. What is happening?",["She is asking for your health card","She is prescribing you antibiotics","She wants you to get an X-ray","She is sending you to a specialist"],1,"Je vais vous prescrire = I am going to prescribe you. Prescrire = to prescribe, des antibiotiques = antibiotics. After this, you'll receive an ordonnance (prescription) to take to the pharmacy!",2),
     {type:"scene",story:"Ravi calls a medical clinic. The receptionist asks 'Avez-vous une carte d'assurance maladie?' (Do you have a health insurance card?)",prompt:"Ravi has his RAMQ card. What should he say?",options:["Oui, j'ai ma carte d'assurance maladie","Non je n'ai pas","Je ne comprends pas","C'est combien?"],correct:0,explain:"Oui, j'ai ma carte d'assurance maladie — perfect! In Quebec, your RAMQ card (carte d'assurance maladie) is required for medical appointments. Always have it ready when you call or visit a clinic.",diff:2},
     {type:"order",prompt:"Book an appointment: I need an appointment please it's not urgent",words:["J'ai","besoin","d'un","rendez-vous","s'il","vous","plaît","ce","n'est","pas","urgent"],answer:["J'ai","besoin","d'un","rendez-vous","s'il","vous","plaît","ce","n'est","pas","urgent"],explain:"J'ai besoin d'un rendez-vous s'il vous plaît, ce n'est pas urgent — a perfect call to a clinic! J'ai besoin de = I need. Ce n'est pas urgent = it's not urgent. You're ready to navigate Quebec healthcare in French!",diff:3},
     wr("Write how you describe having stomach pain for two days",["j'ai mal au ventre depuis deux jours","j'ai mal au ventre","j'ai des douleurs au ventre depuis 2 jours"],"J'ai mal au ventre depuis deux jours — perfect medical French! Depuis + time = for how long. This pattern works for any symptom: j'ai mal à la tête depuis ce matin, j'ai de la fièvre depuis hier.",2)]),

  mkL("a1-06","Present Tense — Action Verbs",25,"writing",
    "You want to say 'I work downtown' or 'She speaks three languages' or 'We eat at 6pm'. For all of this you need the present tense. French verbs change ending depending on who is doing the action. Today you master the 3 verb groups — the building blocks of every French sentence. After this lesson you can make hundreds of new sentences.",
    ["je parle = I speak","tu parles = you speak","il/elle parle = he/she speaks","nous parlons = we speak","vous parlez = you speak (formal/plural)","ils/elles parlent = they speak","-ER verbs: parler, manger, habiter, travailler","-IR verbs: finir, choisir, réussir","-RE verbs: vendre, attendre, répondre","irregular: être, avoir, aller, faire"],
    [mcq("'Je travaill__' — what ending completes this -ER verb?",["es","e","ons","ez"],1,"Je travaille — for je (I), -ER verbs always end in -e. Je parle, je mange, j'habite, je travaille. This is the most common verb pattern in French!",1),
     mcq("'Nous parl__' — what ending for nous?",["e","es","ons","ez"],2,"Nous parlons! For nous (we), -ER verbs always end in -ons. Nous mangeons (we eat), nous habitons (we live), nous travaillons (we work). The -ons ending is the signature of nous!",1),
     {type:"match",prompt:"Match the subject to the correct verb form",pairs:[["Je","parle"],["Tu","parles"],["Il/Elle","parle"],["Nous","parlons"],["Vous","parlez"]],explain:"These are the 5 main forms of parler (to speak) in present tense. The -ER pattern works for 90% of regular French verbs — master this and you can conjugate hundreds of verbs!",diff:1},
     {type:"fill",before:"Sara",blank:"___",after:"à Montreal depuis 2 ans. (Sara lives in Montreal)",options:["habite","habites","habitons","habitez"],correct:0,explain:"Sara habite = Sara lives. For il/elle/on, -ER verbs end in -e — same as je! Je parle, il parle, elle habite, on travaille. Context tells you who is speaking.",diff:2},
     mcq("Which sentence is correct?",["Vous travaillez au bureau","Vous travaille au bureau","Vous travaillons au bureau","Vous travailles au bureau"],0,"Vous travaillez — for vous (you formal/plural), -ER verbs end in -ez. Vous parlez, vous habitez, vous mangez. This is the polite form — essential for work and formal situations in Quebec!",2),
     {type:"scene",story:"Ravi is telling his new coworker about himself in French. He wants to say: I work at the hospital, I speak English and French, and I live in Laval.",prompt:"Which is correct?",options:["Je travaille à l'hôpital, je parle anglais et français, et j'habite à Laval","Je travailles à l'hôpital, je parles anglais et français, et j'habites à Laval","Je travaillons, je parlons, et j'habitons à Laval","Je travail, je parle, et j'habite Laval"],correct:0,explain:"Je travaille, je parle, j'habite — all correct -ER verb forms with je! No article before languages (je parle anglais, not je parle l'anglais). À l'hôpital — à before vowel becomes à l'. Perfect sentence!",diff:2},
     {type:"order",prompt:"Build: We work and we live in Montreal",words:["Nous","travaillons","et","nous","habitons","à","Montréal"],answer:["Nous","travaillons","et","nous","habitons","à","Montréal"],explain:"Nous travaillons et nous habitons à Montréal! Both verbs correctly conjugated with nous (-ons ending). This kind of sentence is perfect for introducing yourself and your family in Quebec.",diff:2},
     wr("Write a sentence about what you do every day using a French verb",["je travaille","je parle","je mange","j'habite","je lis","j'étudie"],"Excellent use of present tense! Now you can make sentences about your daily life, your job, your habits. The present tense is the foundation of all French conversation.",2)]),

  mkL("a1-07","Avoir & Être — The Two Key Verbs",25,"speaking",
    "Two verbs run ALL of French: avoir (to have) and être (to be). You use them dozens of times every day. They are irregular — meaning you must memorize them. But the good news? Once you know them, you can form the past tense (passé composé) of every verb in French. Today is one of the most important lessons in the entire course.",
    ["ÊTRE: je suis, tu es, il est, nous sommes, vous êtes, ils sont","AVOIR: j'ai, tu as, il a, nous avons, vous avez, ils ont","être: identity, location, description","avoir: possession, age, symptoms","J'ai faim = I'm hungry (literally I have hunger)","J'ai soif = I'm thirsty","J'ai chaud = I'm hot","J'ai froid = I'm cold","Il est médecin = He is a doctor (no article!)","C'est + article = C'est un médecin"],
    [mcq("'Je __ médecin.' How do you say 'I am a doctor'?",["j'ai","je suis","j'habite","je vais"],1,"Je suis médecin — after être, NO article before professions! Je suis infirmière, je suis professeur, je suis ingénieur. But with C'est: C'est un médecin (with article). Important difference!",1),
     mcq("'J'__ froid.' I am cold — which verb?",["suis","habite","ai","vais"],2,"J'ai froid! In French, physical sensations use AVOIR: j'ai faim (hungry), j'ai soif (thirsty), j'ai froid (cold), j'ai chaud (hot), j'ai peur (scared). Never 'je suis froid'!",1),
     {type:"match",prompt:"Match avoir expressions to English",pairs:[["J'ai faim","I'm hungry"],["J'ai soif","I'm thirsty"],["J'ai chaud","I'm hot"],["J'ai froid","I'm cold"],["J'ai peur","I'm scared"]],explain:"French uses AVOIR (to have) for feelings! J'ai faim = literally I have hunger. These expressions sound strange in English but are completely natural in French. Learn them as fixed phrases!",diff:1},
     {type:"fill",before:"Nous",blank:"___",after:"trois enfants. (We have three children)",options:["sommes","avons","êtes","ont"],correct:1,explain:"Nous avons = we have. AVOIR conjugation: j'ai, tu as, il/elle a, nous avons, vous avez, ils/elles ont. Avons = have (nous form). Nous avons une maison, nous avons deux voitures, nous avons trois enfants.",diff:2},
     mcq("Which is correct: She is tired?",["Elle a fatiguée","Elle est fatiguée","Elle ai fatiguée","Elle sont fatiguée"],1,"Elle est fatiguée — tired is an adjective so it uses ÊTRE. Note the -e at the end because elle (she) is feminine! Elle est fatiguée, il est fatigué. Adjectives agree with the subject!",2),
     {type:"scene",story:"Sara meets her new neighbor. The neighbor asks 'Vous êtes d'où?' (Where are you from?) and 'Vous avez des enfants?' (Do you have children?)",prompt:"Sara is from India and has 2 children. What should she say?",options:["Je suis d'Inde et j'ai deux enfants","J'ai d'Inde et je suis deux enfants","Je suis d'Inde et je suis deux enfants","J'habite d'Inde et j'ai enfants deux"],correct:0,explain:"Je suis d'Inde (être for origin) et j'ai deux enfants (avoir for possession). Perfect use of both verbs! This conversation happens constantly with neighbours, coworkers, and at school pickup.",diff:2},
     {type:"order",prompt:"Say: We are Canadian and we have a big family",words:["Nous","sommes","canadiens","et","nous","avons","une","grande","famille"],answer:["Nous","sommes","canadiens","et","nous","avons","une","grande","famille"],explain:"Nous sommes canadiens (être for nationality) et nous avons une grande famille (avoir for what we have). Grande = big/large (feminine adjective before famille). You're building complex sentences now!",diff:3},
     wr("Write a sentence using both avoir and être",["je suis et j'ai","je suis...et j'ai","j'ai...et je suis"],"Using both être and être in one sentence shows real French fluency! These two verbs are the skeleton of the language. Master them and everything else becomes easier.",2)]),

  mkL("a1-08","Negation — How to Say No",20,"writing",
    "In French you say NO differently than in English. Instead of just 'not', you wrap the verb with two words: ne...pas. It's like putting the verb in a sandwich! Today you learn negation — one of the most used structures in everyday French. You need it to say 'I don't understand', 'I don't have', 'I don't speak English here', and hundreds of other real situations.",
    ["ne...pas = not (je ne parle pas)","ne...plus = no longer (je ne travaille plus)","ne...jamais = never (je ne mange jamais)","ne...rien = nothing (je ne fais rien)","ne...personne = nobody (je ne vois personne)","ne...que = only (je n'ai que 5 dollars)","In spoken French: ne is often dropped!","Je ne comprends pas = I don't understand","Je n'ai pas de... = I don't have any...","Pas de problème! = No problem!"],
    [mcq("How do you say 'I don't speak French'?",["Je parle pas français","Je ne parle pas français","Je pas parle français","Je parle ne français"],1,"Je ne parle pas français — the verb is sandwiched between ne and pas. Ne...pas is always split around the verb. Ne + verb + pas. Je ne parle pas, tu ne comprends pas, elle ne travaille pas.",1),
     mcq("'Je __ travaille __ ici.' I no longer work here:",["ne...jamais","ne...pas","ne...plus","ne...rien"],2,"Je ne travaille plus ici = I no longer work here. Ne...plus = no longer/anymore. Very useful for talking about changes in your life: je n'habite plus là, je ne mange plus de viande.",1),
     {type:"match",prompt:"Match the negative expression to its meaning",pairs:[["ne...pas","not"],["ne...plus","no longer"],["ne...jamais","never"],["ne...rien","nothing"],["ne...que","only"]],explain:"These 5 negative expressions cover 95% of everyday negation in French. Ne...pas is by far the most common. The others add nuance and precision to your French!",diff:1},
     {type:"fill",before:"Je n'ai pas",blank:"___",after:"argent aujourd'hui. (I don't have any money today)",options:["de","du","le","un"],correct:0,explain:"Je n'ai pas DE argent — after negation, articles (un/une/du/de la/des) change to DE (or D' before vowel). Je n'ai pas de voiture, je n'ai pas d'argent, je ne mange pas de viande. Important rule!",diff:2},
     mcq("In spoken Quebec French, what often happens to 'ne'?",["It changes to 'non'","It is often dropped","It moves after the verb","It becomes 'pas'"],1,"In spoken French (especially Quebec!), the 'ne' is often dropped. Je comprends pas, je sais pas, c'est pas grave. You'll hear this constantly on the streets. Both forms are correct but formal writing keeps the ne.",2),
     {type:"scene",story:"Amara is at a store. The cashier says 'Vous avez la carte fidélité?' (Do you have the loyalty card?) Amara doesn't have one.",prompt:"What should Amara say?",options:["Non, je n'ai pas de carte fidélité","Non je pas avoir carte","Non, je ne pas avoir","Je n'ai jamais"],correct:0,explain:"Non, je n'ai pas de carte fidélité — perfect negation! After n'ai pas, de replaces the article. Je n'ai pas de carte (not 'une carte'). This happens every time you check out at a Quebec store!",diff:2},
     {type:"order",prompt:"Build: I never eat meat",words:["Je","ne","mange","jamais","de","viande"],answer:["Je","ne","mange","jamais","de","viande"],explain:"Je ne mange jamais de viande — I never eat meat. Ne...jamais = never. After negation, de replaces du/de la/des. Je ne mange jamais de viande, de sucre, de gluten. Perfect for dietary restrictions!",diff:2},
     wr("Write a negative sentence about something you don't do",["je ne...pas","je n'ai pas","je ne mange pas","je ne parle pas","je ne travaille pas"],"Excellent negation! Now you can decline, refuse, explain limitations, and express what you don't do or have. Negation is used in every conversation. You've mastered a fundamental French structure!",2)]),

  mkL("a1-09","Asking Questions",25,"speaking",
    "In Quebec, you need to ask questions constantly — at work, at the doctor, at the school, in stores. But French questions work differently from English. Today you learn 4 ways to ask any question in French. The simplest way? Just raise your voice at the end of a statement! The most formal? Use inversion. You'll learn them all.",
    ["Intonation: Tu travailles ici? (voice goes up)","Est-ce que: Est-ce que tu travailles ici?","Inversion: Travailles-tu ici?","Question words: Qui, Quoi, Où, Quand, Pourquoi, Comment, Combien","Qui = who","Quoi/Qu'est-ce que = what","Où = where","Quand = when","Pourquoi = why","Comment = how","Combien = how much/many"],
    [mcq("What is the simplest way to ask a question in French?",["Always use inversion","Use est-ce que","Just raise your voice at the end","Start with pourquoi"],2,"Intonation! In spoken French (especially in Quebec), just raise your voice at the end of a statement to make it a question. Tu parles français? Vous êtes médecin? C'est ici? Simple and very natural!",1),
     mcq("How do you ask 'Where do you work?' using Est-ce que?",["Où est-ce que tu travailles?","Est-ce que où tu travailles?","Où tu travailles est-ce que?","Tu travailles où est-ce que?"],0,"Où est-ce que tu travailles? Question word first + est-ce que + subject + verb. Où est-ce que = where does... This is the standard, neutral way to ask questions in French — perfect for all situations!",1),
     {type:"match",prompt:"Match the question word to its meaning",pairs:[["Qui","who"],["Où","where"],["Quand","when"],["Pourquoi","why"],["Comment","how"]],explain:"These 5 question words (Qui, Où, Quand, Pourquoi, Comment) let you ask about any situation. Learn them and you can get information about anything in French!",diff:1},
     {type:"fill",before:"",blank:"___",after:"est-ce que vous habitez? (Where do you live?)",options:["Qui","Où","Quand","Pourquoi"],correct:1,explain:"Où est-ce que vous habitez? = Where do you live? Où = where. This question appears constantly — at the doctor, on forms, meeting new people. Où habitez-vous? is the formal inversion form.",diff:2},
     mcq("How do you ask 'Why are you learning French?'",["Comment tu apprends le français?","Pourquoi est-ce que tu apprends le français?","Quand tu apprends le français?","Qui apprend le français?"],1,"Pourquoi est-ce que tu apprends le français? = Why are you learning French? Pourquoi = why. A great question to practice because you can answer it: J'apprends le français pour travailler, pour m'intégrer, pour mes enfants!",2),
     {type:"scene",story:"Ravi starts a new job. His coworker wants to get to know him. She asks three questions in French.",prompt:"Which set of questions is correct French?",options:["Où est-ce que tu habites? Depuis combien de temps? Pourquoi tu travailles ici?","Où habites? Combien temps? Pourquoi tu?","Est-ce que où? Depuis quand combien? Pourquoi ici travailles?","Habites-tu où? Temps depuis combien? Travailles pourquoi?"],correct:0,explain:"Où est-ce que tu habites? (where do you live?) Depuis combien de temps? (for how long?) Pourquoi tu travailles ici? (why do you work here?) All three are natural, correct French questions!",diff:2},
     {type:"order",prompt:"Ask: How long have you been in Canada?",words:["Depuis","combien","de","temps","êtes-vous","au","Canada?"],answer:["Depuis","combien","de","temps","êtes-vous","au","Canada?"],explain:"Depuis combien de temps êtes-vous au Canada? = How long have you been in Canada? Depuis combien de temps = for how long. This question will be asked of you many times in Quebec — and now you can ask it too!",diff:3},
     wr("Write a question you would ask on your first day of work in French",["pourquoi","où","quand","comment","est-ce que","qui"],"Great question using French question words! On your first day of work in Quebec, these questions show confidence and willingness to communicate. Your coworkers will be impressed!",2)]),

  mkL("a1-10","Past Tense — Passé Composé",30,"writing",
    "Last week you went to the grocery store, met your new neighbor, and had a doctor's appointment. To talk about any of this in French, you need the passé composé — the most common past tense. Today you learn how to talk about anything that happened. It is the most important grammar structure for telling stories and sharing experiences in Canada.",
    ["AVOIR + past participle: j'ai mangé (I ate)","ÊTRE + past participle: je suis allé (I went)","Regular past participles: -ER → é, -IR → i, -RE → u","parlé, mangé, travaillé (from -ER verbs)","fini, choisi, réussi (from -IR verbs)","vendu, attendu (from -RE verbs)","Irregular: fait, été, eu, vu, dit, pris","ÊTRE verbs: aller, venir, partir, arriver, naître, mourir","Agreement: je suis allée (feminine adds -e)","Negation: je n'ai pas mangé"],
    [mcq("'J'__ mangé au restaurant hier.' Which auxiliary?",["suis","ai","es","a"],1,"J'ai mangé = I ate. Most verbs use AVOIR as auxiliary. J'ai mangé (manger→mangé), j'ai travaillé (travailler→travaillé), j'ai parlé (parler→parlé). The -ER ending becomes -é in past participle!",1),
     mcq("'Je __ allé au travail.' Which auxiliary for aller?",["ai","suis","as","avons"],1,"Je suis allé! Aller uses ÊTRE as auxiliary. Remember: DR MRS VANDERTRAMP or think of movement verbs — aller, venir, partir, arriver, naître, mourir, entrer, sortir all use ÊTRE!",1),
     {type:"match",prompt:"Match the verb to its past participle",pairs:[["parler","parlé"],["finir","fini"],["vendre","vendu"],["faire","fait"],["avoir","eu"]],explain:"Past participles — regular and irregular! -ER verbs: parlé. -IR verbs: fini. -RE verbs: vendu. Irregular: fait (faire), eu (avoir), été (être), vu (voir). These 5 are the most used!",diff:2},
     {type:"fill",before:"Hier, Sara est",blank:"___",after:"au supermarché.",options:["allée","allé","allés","alla"],correct:0,explain:"Sara est allée — Sara (feminine) used être auxiliary + past participle agrees with subject! Sara is feminine so allée adds -e. If it was Ravi: il est allé. Agreement is required with être verbs!",diff:2},
     mcq("How do you say 'I didn't eat this morning'?",["Je ne pas ai mangé ce matin","Je n'ai pas mangé ce matin","Je n'ai mangé pas ce matin","J'ai ne mangé pas ce matin"],1,"Je n'ai pas mangé = I didn't eat. Negation in passé composé: ne + auxiliary + pas + past participle. Ne...pas wraps around the auxiliary (ai), not around the whole phrase!",2),
     {type:"scene",story:"Amara calls her friend to share her day. She wants to say: This morning I went to the doctor, I waited one hour, and I got a prescription.",prompt:"Which is correct?",options:["Ce matin je suis allée chez le médecin, j'ai attendu une heure, et j'ai eu une ordonnance","Ce matin j'ai allée chez le médecin, j'ai attendu une heure, et j'ai pris une ordonnance","Ce matin je suis allé chez le médecin, j'ai attendu une heure, et j'avais une ordonnance","Ce matin j'aller chez médecin, attendre une heure, et avoir ordonnance"],correct:0,explain:"Suis allée (être + agreement), j'ai attendu (avoir, past participle of attendre = attendu), j'ai eu (avoir, past participle of avoir = eu). Three verbs correctly conjugated in passé composé — impressive!",diff:3},
     {type:"order",prompt:"Say: Yesterday I worked and then I went home",words:["Hier","j'ai","travaillé","et","ensuite","je","suis","rentré","à","la","maison"],answer:["Hier","j'ai","travaillé","et","ensuite","je","suis","rentré","à","la","maison"],explain:"Hier j'ai travaillé (avoir + travaillé) et ensuite je suis rentré à la maison (être + rentré). Two different auxiliaries in one sentence — you're using advanced French now! Ensuite = then/afterwards.",diff:3},
     wr("Write what you did yesterday using passé composé",["j'ai","je suis","hier j'ai","hier je suis","j'ai mangé","je suis allé"],"Excellent use of passé composé! You can now talk about your past experiences, tell stories, and share what happened. This tense is used in 90% of past conversations in French.",2)]),
  mkL("a1-11","Articles — le, la, les, un, une, des",20,"reading",
    "Every French noun has an article — definite (the) or indefinite (a/some). And every noun has a gender. This is the SINGLE biggest difference between English and French. Today you master the article system: when to use le/la/les vs un/une/des. Get this right and your French sounds natural.",
    ["le + masculine: le livre, le café, le pain","la + feminine: la table, la voiture, la maison","les + plural: les enfants, les amis","un = a/an (masculine): un homme, un café","une = a/an (feminine): une femme, une rue","des = some/any (plural): des amis, des livres","l' before vowel/silent h: l'ami, l'hôpital","Definite (the) vs Indefinite (a/some)"],
    [mcq("Which article? '__ pomme est rouge.' (The apple is red — pomme is feminine)",["Le","La","Les","Un"],1,"La pomme = the apple. Pomme is feminine, so 'la'. Memorize gender with the article: 'la pomme' (always together). When you learn vocabulary, ALWAYS learn the article!",1),
     mcq("Choose the right plural article: '__ enfants jouent au parc.'",["Le","La","Les","Un"],2,"Les enfants! 'Les' is the plural definite article — works for both genders. Le/la become 'les' in plural. Pattern: le garçon → les garçons, la fille → les filles.",1),
     {type:"match",prompt:"Match the noun to its correct article",pairs:[["café","le"],["voiture","la"],["enfants","les"],["ami","un"],["femme","une"]],explain:"Five common articles in action. Notice: café (masc) → le or un. Voiture (fem) → la or une. Memorize gender + article together — it becomes second nature!",diff:2},
     {type:"fill",before:"J'ai",blank:"___",after:"chien et deux chats. (I have a dog and two cats)",options:["le","la","un","une"],correct:2,explain:"Un chien! 'Un' = a (masculine indefinite). 'I have A dog' uses indefinite article. 'Le chien' would be 'the (specific) dog'. Important difference!",diff:2},
     mcq("'__ étudiants travaillent beaucoup.' (Students work a lot — talking generally)",["Les","Des","Le","La"],0,"Les étudiants! When you talk about a group in general, use 'les' (definite plural). 'Des étudiants' = some specific students. 'Les' is for general statements.",2),
     {type:"scene",story:"In a Quebec restaurant, you order: 'Je voudrais __ café et __ croissant s'il vous plaît.' What articles fit?",prompt:"Best articles?",options:["le, le","un, un","la, la","une, un"],correct:1,explain:"Un café et un croissant! When ordering, use 'un/une' (one of these items, no specific one). Café and croissant are both masculine. Easy ordering!",diff:2},
     wr("Write 'I love the cat' (cat = chat, masculine)",["j'aime le chat","j'aime mon chat","aime le chat"],"J'aime le chat! 'Aimer' is followed by definite article when expressing love/preference for general thing. 'J'aime LE café' = I love coffee (in general).",2)]),
  mkL("a1-12","Gender of Nouns — Masculine vs Feminine",20,"reading",
    "Every French noun is either masculine or feminine — even objects! La table (feminine), le livre (masculine). There's no logical reason for most. But there ARE patterns: words ending in -e tend to be feminine, -tion words are feminine, -ment words are masculine. Today you learn the patterns to predict gender 80% of the time.",
    ["Most -e endings: feminine (la table, la chaise)","Most consonant endings: masculine (le livre, le pain)","-tion, -sion: feminine (la nation, la maison)","-ment: masculine (le moment, le département)","-eau: masculine (le bureau, l'eau IS feminine — exception!)","-té: feminine (la beauté, la santé)","People: usually match real gender (le frère, la soeur)","When in doubt, look it up!"],
    [mcq("'__ situation est difficile.' What article?",["Le","La","Les","Un"],1,"La situation. -tion ending = feminine almost always. La nation, la station, la pollution, la solution. This pattern saves you from many mistakes!",1),
     mcq("'__ département de Montréal' (the department of Montreal). Article?",["Le","La","Les","L'"],0,"Le département! -ment ending = masculine. Le moment, le bâtiment, le développement, le département. Reliable pattern!",1),
     {type:"match",prompt:"Predict gender by ending",pairs:[["la chanson","feminine -son"],["le pain","masculine consonant"],["la beauté","feminine -té"],["le château","masculine -eau"],["la liberté","feminine -té"]],explain:"Patterns help! -son, -té, -tion → feminine. Consonant endings, -eau, -ment → masculine. Not 100% but very useful!",diff:2},
     {type:"fill",before:"J'aime",blank:"___",after:"liberté! (I love freedom — liberté is feminine)",options:["le","la","les","l'"],correct:1,explain:"La liberté! Words ending in -té are almost always feminine. La liberté, la beauté, la qualité, la santé. Memorize the pattern!",diff:2},
     mcq("Quick gender check — which is FEMININE?",["le café","le livre","la maison","le pain"],2,"La maison = the house (feminine). Common Quebec word. -son ending often feminine. The others are all masculine.",1),
     wr("Write 'the school' in French (école = école)",["l'école","l'ecole","la école","ecole"],"L'école! École starts with a vowel, so we use l' (elision of la). With la, it would be la école → l'école. Same applies to l'ami, l'eau, l'hôtel.",2)]),
  mkL("a1-13","Plural Forms — How to Pluralize",18,"reading",
    "Most French plurals add -s like English. But some endings have special rules. -al becomes -aux. -eau becomes -eaux. Plurals also affect articles (le → les, un → des). Today you master French plurals — a small but essential skill for sounding fluent.",
    ["Most plurals: add -s (le livre → les livres)","-al → -aux: le journal → les journaux","-eau → -eaux: le bureau → les bureaux","-eu → -eux: le cheveu → les cheveux","Already ending -s/-x/-z: no change (le pays → les pays)","Articles change: le/la → les, un/une → des","Adjectives also become plural","Pronunciation: -s and -x are silent!"],
    [mcq("Plural of 'le journal'?",["les journals","les journaux","les journale","les journal"],1,"Les journaux! -al endings change to -aux in plural. Cheval → chevaux (horses), animal → animaux (animals), journal → journaux (newspapers). Important irregular pattern!",1),
     mcq("Plural of 'l'oiseau' (the bird)?",["les oiseaus","les oiseaux","les oiseaues","les oiseau"],1,"Les oiseaux! -eau adds -x in plural (not -s). Bureau → bureaux, eau → eaux, oiseau → oiseaux. Memorize -eau→-eaux!",2),
     {type:"match",prompt:"Singular → Plural",pairs:[["le livre","les livres"],["la femme","les femmes"],["un homme","des hommes"],["le bureau","les bureaux"],["l'animal","les animaux"]],explain:"Notice: bureau → bureaux (-x not -s), animal → animaux (-aux). All other regular nouns just add -s. Five different patterns in one set!",diff:2},
     {type:"fill",before:"Il y a beaucoup d'",blank:"___",after:"dans cette région. (animals — l'animal)",options:["animals","animaux","animales","animale"],correct:1,explain:"Animaux! -al → -aux is fundamental. Hôpitaux (hospitals), journaux (newspapers), nationaux (nationals). Get this pattern automatic.",diff:2},
     mcq("How do you pronounce the -s in 'les enfants'?",["like S","silent","like Z","like T"],1,"Silent! French plural -s is rarely pronounced. The 'les' tells you it's plural. EXCEPTION: liaison — when followed by vowel, -s sounds like Z (les_enfants → 'lay-zahn-fahn').",2),
     wr("Plural of 'la voiture'",["les voitures","voitures"],"Les voitures! Regular feminine plural — just add -s. La voiture (the car) → les voitures (the cars). Most plurals work this way!",2)]),
  mkL("a1-14","Adjective Agreement — Making Adjectives Match",22,"writing",
    "French adjectives MUST agree with the noun in gender AND number. Un grand homme (a tall man), une grande femme (a tall woman). This concept doesn't exist in English. Today you master the rules so your French sounds correct.",
    ["Masculine + feminine: add -e (grand → grande)","Singular + plural: add -s (grand → grands)","Both: feminine + plural (grande → grandes)","Already ending in -e: no change for feminine (jeune)","Special endings: -er → -ère (cher → chère)","-eux → -euse (heureux → heureuse)","-f → -ve (actif → active)","Adjective often follows the noun!"],
    [mcq("'Une __ voiture' (a beautiful car). Beau is the adjective.",["beau","belle","beaux","belles"],1,"Belle! Beau (masc) → belle (fem). Voiture is feminine, so we need feminine adjective. 'Une belle voiture'. Beau/bel/belle is irregular — memorize all forms!",1),
     mcq("'Des amis __'(happy friends, plural masculine).",["heureux","heureuse","heureuses","heureuxs"],0,"Heureux! Already ends in -x, so plural masculine = same form. heureux → heureuse (fem) → heureux (plural masc) → heureuses (plural fem). The -eux/-euse pattern!",2),
     {type:"match",prompt:"Match adjective forms",pairs:[["grand → grande","masc → fem"],["petit → petite","masc → fem"],["actif → active","-f → -ve"],["heureux → heureuse","-eux → -euse"],["nouveau → nouvelle","irregular"]],explain:"Five common patterns. Notice nouveau is special (nouveau/nouvelle), like beau (beau/belle). Active and heureuse follow regular -f→-ve and -eux→-euse rules.",diff:3},
     {type:"fill",before:"Mes amis sont très",blank:"___",after:". (gentil — kind, plural masculine)",options:["gentils","gentilles","gentile","gentil"],correct:0,explain:"Gentils! Gentil (masc sing) → gentille (fem sing) → gentils (masc plural) → gentilles (fem plural). Plurals add -s. Friends (amis) is masculine plural!",diff:2},
     mcq("Where does the adjective go in 'a small house' (petite, maison)?",["Une petite maison","Une maison petite","Petite une maison","Maison une petite"],0,"Une petite maison! Most short adjectives go BEFORE the noun: petit, grand, beau, jeune, vieux, bon, mauvais. Long adjectives usually go AFTER: une voiture rouge, un café noir.",2),
     wr("Write 'a small black cat' (petit + noir, chat is masculine)",["un petit chat noir","petit chat noir"],"Un petit chat noir! Petit (small) before noun, noir (color) after noun. Both masculine to match chat. This is THE classic French adjective placement pattern!",3)]),
  mkL("a1-15","Possessive Adjectives — My, Your, His, Her",20,"speaking",
    "How do you say 'my brother', 'your house', 'his car'? French has 3 forms for each possessive — based on the noun's gender and number. Mon, ma, mes (my). Ton, ta, tes (your). Son, sa, ses (his/her). Today you learn the system that lets you talk about anyone's anything in French.",
    ["mon (masc), ma (fem), mes (plural) = my","ton (masc), ta (fem), tes (plural) = your (informal)","son (masc), sa (fem), ses (plural) = his/her","notre (sing), nos (plural) = our","votre (sing), vos (plural) = your (formal/plural)","leur (sing), leurs (plural) = their","Before vowel: ma→mon (mon amie!)","Possessive matches the THING, not the owner"],
    [mcq("'__ frère habite à Toronto.' (My brother lives in Toronto)",["Mon","Ma","Mes","Ton"],0,"Mon frère! Frère is masculine, so 'mon' = my. Pattern: mon (masc), ma (fem), mes (plural). Memorize trios as a set.",1),
     mcq("'C'est __ voiture, n'est-ce pas?' (It's your car, right? — voiture is feminine)",["ton","ta","tes","te"],1,"Ta voiture! Voiture is feminine, so 'ta' = your. Ta is the feminine equivalent of ton. With informal you (tu). Formal/plural would be 'votre voiture'.",1),
     {type:"match",prompt:"Match the possessive to its meaning",pairs:[["mon","my (masc)"],["ma","my (fem)"],["mes","my (plural)"],["votre","your (formal)"],["leurs","their (plural)"]],explain:"Five key possessives. Notice: 'votre' singular form, 'vos' plural. 'Leur' singular, 'leurs' plural. Always match the THING owned, not the owner.",diff:2},
     {type:"fill",before:"Sara aime",blank:"___",after:"travail. (Sara loves her job — travail is masculine)",options:["son","sa","ses","ta"],correct:0,explain:"Son travail! Even though Sara is female, 'travail' is masculine, so we use 'son' (masc form). Possessive matches the THING (travail), not the owner (Sara). Trip-up for English speakers!",diff:3},
     mcq("'Notre __ est à Montréal.' (Our office is in Montreal — bureau is masculine)",["bureau","bureaux","bureauNous","bureaue"],0,"Notre bureau! 'Notre' is the same for masculine and feminine (no gender distinction). Notre frère, notre soeur. Plural: nos. Notre bureau (our office), nos bureaux (our offices).",2),
     wr("Write 'I love my mother' (mère is feminine)",["j'aime ma mère","j'aime ma mere","aime ma mère"],"J'aime ma mère! Mère is feminine, so 'ma'. Beautiful expression — Quebec families celebrate Mother's Day (Fête des Mères) every May. Use this phrase warmly!",2)]),
  mkL("a1-16","Demonstratives — This, That, These, Those",18,"reading",
    "How do you point and say 'THIS book' or 'THAT car'? French uses ce, cette, ces. The system is like articles — based on gender and number. Today you learn demonstratives that let you point at anything specific.",
    ["ce + masculine: ce livre, ce chat","cet + masc starting with vowel: cet ami","cette + feminine: cette femme, cette voiture","ces + plural: ces livres, ces enfants","ce/ça = it / this / that (general)","C'est = It is","-ci = here, -là = there","ce livre-ci = this book here"],
    [mcq("'__ livre est intéressant.' (This/that book is interesting)",["Ce","Cette","Ces","Cet"],0,"Ce livre! Livre is masculine, so 'ce'. If livre started with a vowel, we'd use 'cet'. Cet animal, cet homme, cet ami. Watch for vowels!",1),
     mcq("'__ amie habite à Québec.' (This friend — amie feminine)",["Ce","Cette","Ces","Cet"],1,"Cette amie! Amie is feminine, so 'cette'. Plural would be 'ces amies'. Notice: cette/cet sound the same but 'cet' is masculine, 'cette' is feminine.",2),
     {type:"match",prompt:"Match demonstratives to nouns",pairs:[["ce film","masculine sing"],["cette femme","feminine sing"],["ces enfants","plural"],["cet hôtel","masc + vowel"],["cette voiture","feminine sing"]],explain:"All 4 forms — ce, cet (vowel), cette (fem), ces (plural). Hôtel takes 'cet' because it starts with silent H (treated as vowel).",diff:2},
     {type:"fill",before:"Regarde",blank:"___",after:"chiens! (Look at these dogs)",options:["ce","cette","ces","cet"],correct:2,explain:"Ces chiens! 'Ces' for any plural — masculine or feminine. Ces enfants (these children), ces voitures (these cars), ces livres (these books). Same form for both genders!",diff:1},
     mcq("How do you specify 'this book HERE' vs 'that book OVER THERE'?",["ce livre this, ce livre that","ce livre-ci, ce livre-là","ici livre, là livre","celui-ci, celui-là"],1,"Ce livre-ci (this one here) vs ce livre-là (that one there)! The -ci/-là suffixes specify near/far. Used when you need to distinguish 'this one' from 'that one'.",3),
     wr("Write 'this car is fast' (car = voiture, fast = rapide)",["cette voiture est rapide","cette voiture est rapid","voiture est rapide"],"Cette voiture est rapide! Voiture is feminine = cette. Rapide already ends in -e (no change for fem). Now you can describe specific things in French!",2)]),
  mkL("a1-17","Direct Object Pronouns — le, la, les",20,"speaking",
    "Instead of repeating 'le livre' constantly, you say 'I read it'. French direct object pronouns are le (it/him), la (it/her), les (them). They go BEFORE the verb (different from English!). Today you learn to speak more naturally by replacing nouns with pronouns.",
    ["me = me | te = you (informal)","le = him/it (masc) | la = her/it (fem)","nous = us | vous = you (formal/plural)","les = them","Pronoun goes BEFORE the verb!","Je le vois = I see him/it","Je la connais = I know her","Je les aime = I love them"],
    [mcq("Replace 'le livre': 'Je lis le livre' becomes...",["Je lis le","Je le lis","Je lis le lui","Je lis l'"],1,"Je le lis! Direct object pronoun 'le' replaces 'le livre'. Goes BEFORE the verb 'lis'. Pattern: Je + [pronoun] + verb. Different from English where pronoun goes AFTER verb!",2),
     mcq("'Tu __ vois?' (Do you see her? — talking about Sara)",["le","la","les","l'"],1,"Tu la vois? La = her/it (feminine). Sara is feminine, so 'la'. Note: before vowels, 'la' becomes l': Tu l'aimes? (Do you love her?)",1),
     {type:"match",prompt:"Match the pronoun",pairs:[["le","him/it (masc)"],["la","her/it (fem)"],["les","them"],["me","me"],["nous","us"]],explain:"Five direct object pronouns. They REPLACE nouns to avoid repetition. They go BEFORE the conjugated verb in French (totally different from English placement).",diff:2},
     {type:"fill",before:"Il aime sa soeur. Il",blank:"___",after:"voit chaque jour.",options:["le","la","les","l'"],correct:1,explain:"Il la voit. La = her (feminine, replacing 'sa soeur'). Goes before 'voit'. He sees her every day.",diff:2},
     mcq("How do you say 'I love them' (talking about my parents)?",["J'aime les","Je les aime","J'aime ils","J'eux aime"],1,"Je les aime! 'Les' replaces 'mes parents' (them, plural). Always before the verb! 'J'aime les' is wrong — pronoun comes BEFORE conjugated verb. Practice this difference!",2),
     wr("Write 'I see him' in French (use 'le')",["je le vois","le vois"],"Je le vois! Direct object pronoun 'le' = him/it (masculine), placed before the verb 'vois'. Now you can replace any masculine noun with 'le'!",2)]),
  mkL("a1-18","Indirect Object Pronouns — lui, leur",20,"speaking",
    "Some verbs need 'to someone' — give TO him, talk TO her, write TO them. French uses indirect object pronouns: lui (to him/her) and leur (to them). They also go BEFORE the verb. Today you learn the difference between direct and indirect objects.",
    ["lui = to him / to her (singular, ambiguous!)","leur = to them","Used with verbs like donner (give), parler (talk), écrire (write)","Je lui parle = I talk to him/her","Je leur donne = I give to them","Pronoun before the verb!","'À' often signals indirect object","Don't add -s to leur (already plural meaning)"],
    [mcq("'Je parle à Sara' becomes 'Je __ parle.'",["la","lui","leur","l'"],1,"Je lui parle! 'Parler à' = talk TO someone (indirect). 'Lui' = to her (or to him). The 'à' tells you it's indirect. Sara is replaced by lui (not la!).",2),
     mcq("'J'écris à mes parents' becomes 'Je __ écris.'",["leur","les","leurs","lui"],0,"Je leur écris! 'Leur' = to them. Even though parents are masc plural, indirect = leur (no gender). Don't add -s: it's already plural in meaning.",2),
     {type:"match",prompt:"Match the verb to its pronoun",pairs:[["donner à","lui/leur"],["parler à","lui/leur"],["écrire à","lui/leur"],["répondre à","lui/leur"],["téléphoner à","lui/leur"]],explain:"All these verbs require 'à' before the person — they're indirect object verbs. Replace the person with lui (singular) or leur (plural). Pattern: Je + lui/leur + verb.",diff:3},
     {type:"fill",before:"Tu téléphones à ton père? Oui, je",blank:"___",after:"téléphone ce soir.",options:["le","la","lui","leur"],correct:2,explain:"Lui! 'Téléphoner à' = call/phone TO someone. Indirect object. 'À ton père' (singular masc, but indirect) = lui. Even though 'le' would be tempting, the verb takes 'à'.",diff:3},
     mcq("'I gave them my phone number' (donner — to give)",["Je les ai donné mon numéro","Je leur ai donné mon numéro","Je leurs ai donné mon numéro","Je l'ai donné mon numéro"],1,"Je leur ai donné mon numéro! Donner À + person = indirect. Leur = to them. Note: leur stays the same, even with plural meaning. No 's' on leur as a pronoun!",3),
     wr("Write 'I am writing to her' in French",["je lui écris","lui écris"],"Je lui écris! Écrire à quelqu'un = write to someone. Indirect = lui (to her/him, ambiguous from gender alone). Goes before the verb. You're using advanced French!",3)]),
  mkL("a1-19","The Pronoun Y — There / About It",18,"speaking",
    "Y is a tiny but POWERFUL French pronoun. It replaces 'à + place' or 'à + thing'. Je vais à Montréal → J'y vais (I'm going there). Tu penses au travail → Tu y penses (You're thinking about it). Today you master Y — one of the most-used French pronouns.",
    ["Y replaces 'à + place' = there","Y replaces 'à + thing' = about it / to it","J'y vais = I go there / I'm going there","Tu y penses = You're thinking about it","On y va! = Let's go (there)!","Always BEFORE the verb","Doesn't replace 'à + person' (use lui/leur for that!)","Common in commands: vas-y! (go!)"],
    [mcq("Replace 'Je vais à Montréal' with Y:",["Je vais y","J'y vais","Je y vais","J'y","y vais"],1,"J'y vais! Y replaces 'à Montréal' (place). Goes before vais. Notice: 'je' becomes 'j'' before y (vowel sound). Common Quebec phrase: 'J'y vais' = I'm going there.",2),
     mcq("'Tu penses à tes vacances?' Replace with Y:",["Tu y penses?","Tu penses y?","Tu y?","Y penses-tu?"],0,"Tu y penses? Y replaces 'à tes vacances' (à + thing). 'Penser à' = think about. Y captures the whole 'à + thing' phrase.",2),
     {type:"match",prompt:"What does Y replace?",pairs:[["J'y vais","à un endroit"],["Y penses-tu?","à quelque chose"],["On y va!","à un endroit"],["Allons-y","à un endroit"],["J'y crois","à quelque chose"]],explain:"Y replaces ANY 'à + place' or 'à + thing'. Five common uses. Master the pattern and you sound MUCH more fluent!",diff:3},
     {type:"fill",before:"Tu vas au gym? Oui, j'",blank:"___",after:"vais après le travail.",options:["la","le","y","en"],correct:2,explain:"J'y vais! Y replaces 'au gym' (à + place). Goes before vais. Saves you from repeating 'au gym'. Natural French speech relies on Y constantly.",diff:2},
     mcq("'Allons-y!' means:",["Let's go there!","Are you there?","Let's see!","Goodbye!"],0,"Allons-y! = Let's go (there)! 'Y' is built into this very common phrase. Quebecers say it constantly — when leaving for work, going out, starting any activity. Use it!",1),
     wr("Write 'Yes, I'm thinking about it' (using Y)",["oui, j'y pense","j'y pense","oui j'y pense"],"Oui, j'y pense! Y replaces 'à ça' or 'à ce sujet' (about it/that). Common in conversations: 'Tu y as pensé?' (Did you think about it?). Use Y to sound naturally fluent!",3)]),
  mkL("a1-20","The Pronoun EN — Some / About / Of It",20,"speaking",
    "EN is the partner of Y. It replaces 'de + something'. J'ai du café → J'en ai (I have some). Combien de? → J'en ai trois (I have three). EN means 'some/of it/about it'. Today you complete the pronoun system with EN.",
    ["EN replaces 'de + thing' = some / of it","EN with quantities: J'en ai cinq (I have five)","EN with partitive: Tu veux du café? J'en veux! (Yes I want some!)","Always BEFORE the verb","Combien? Use EN: J'en ai deux","Negation: Je n'en ai pas (I don't have any)","Doesn't replace 'de + person' usually","Pairs with Y in advanced French"],
    [mcq("'Tu as du café?' Reply 'Yes I have some'",["Oui, j'en ai","Oui, j'ai","Oui, je l'ai","Oui, je en ai"],0,"Oui, j'en ai! 'En' replaces 'du café' (de + thing). Goes before 'ai'. 'J'en' (avoid je en — elision before vowel). Quebecers use 'J'en ai' constantly!",2),
     mcq("'Combien d'enfants as-tu?' Reply 'I have three'",["J'ai trois","J'en ai trois","J'ai trois enfants","Je trois ai"],1,"J'en ai trois! When stating a quantity, EN is required: 'J'en ai trois (enfants)'. Without EN it sounds incomplete. Memorize this pattern with all numbers!",2),
     {type:"match",prompt:"What EN replaces",pairs:[["J'en veux","de cette chose"],["J'en ai trois","quantité"],["Je n'en ai pas","aucun"],["J'en parle","de ce sujet"],["Beaucoup en ont","de ces choses"]],explain:"EN appears in many ways — quantity, partitive, negation. The common thread: replaces 'de + something'. Master EN to sound fluent!",diff:3},
     {type:"fill",before:"Tu manges des pommes? Oui, j'",blank:"___",after:"mange tous les jours.",options:["la","y","en","le"],correct:2,explain:"J'en mange! 'En' replaces 'des pommes' (de + thing, partitive). Goes before 'mange'. 'I eat some [apples] every day' — natural, fluent French!",diff:2},
     mcq("'Je n'en veux pas' means:",["I want some","I don't want any","I want it","I don't have any"],1,"Je n'en veux pas = I don't want any! In negation, EN keeps its place: ne + en + verb + pas. Useful when refusing food/drinks: 'Voulez-vous du vin? Non, je n'en veux pas, merci.'",2),
     wr("Write 'I have some' (using EN)",["j'en ai","en ai"],"J'en ai! Two-word answer that's perfectly French. Without EN, you'd sound like a beginner. Add an item: J'en ai (de l'argent), J'en ai (des amis). Versatile!",3)]),
  mkL("a1-21","At the Bank",22,"speaking",
    "Opening your first bank account in Canada is essential. Desjardins, RBC, BMO, Scotia — many Quebec banks operate primarily in French. Today you learn the vocabulary and phrases for opening an account, asking about balances, and making basic transactions. After this lesson you can handle a Quebec bank visit confidently.",
    ["la banque = the bank","un compte = an account","ouvrir un compte = open an account","le solde = balance","une carte de débit = debit card","un dépôt = a deposit","un retrait = a withdrawal","les frais = fees","Quel est le solde de mon compte? = What's my account balance?","Je voudrais ouvrir un compte = I would like to open an account"],
    [mcq("Most useful phrase to start at the bank:",["Bonjour, je voudrais ouvrir un compte","Compte!","Money please","Bonjour"],0,"Bonjour, je voudrais ouvrir un compte! Polite, clear, gets the conversation started. The teller will ask for ID (carte d'identité) and proof of address.",1),
     mcq("'Quel est le solde?' What did you ask?",["What's the balance?","What's the time?","What's the fee?","What's the date?"],0,"What's the balance? 'Solde' = balance. Useful at ATMs and when reviewing statements (relevés bancaires).",2),
     {type:"match",prompt:"Match banking words",pairs:[["un compte","an account"],["un dépôt","a deposit"],["un retrait","a withdrawal"],["les frais","fees"],["la carte de débit","debit card"]],explain:"5 essentials for any bank visit. Tip: Quebec banks often use 'compte chèques' for chequing and 'compte épargne' for savings.",diff:2},
     {type:"fill",before:"Je voudrais faire un",blank:"___",after:"de 500 dollars. (deposit)",options:["retrait","dépôt","compte","frais"],correct:1,explain:"Un dépôt = a deposit. 'Faire un dépôt' = to make a deposit. Opposite is 'faire un retrait' (withdrawal).",diff:2},
     wr("Write 'I want to open a chequing account' (chequing = chèques)",["je voudrais ouvrir un compte chèques","ouvrir un compte chèques","je veux ouvrir un compte chèques"],"Je voudrais ouvrir un compte chèques! Standard request for daily banking. Most immigrants get this within a week of arrival.",2)]),
  mkL("a1-22","At the Post Office",18,"reading",
    "Sending packages, buying stamps, picking up registered mail — Canada Post (Postes Canada) is part of life in Canada. The post office uses French in Quebec. Today you learn how to mail letters and packages, ask about delivery times, and handle the basics of Postes Canada.",
    ["la poste = post office","un timbre = a stamp","une lettre = a letter","un colis = a package","une enveloppe = an envelope","l'adresse = the address","le code postal = the postal code","le destinataire = the recipient","par avion = by plane (airmail)","Combien ça coûte pour envoyer? = How much to send?"],
    [mcq("Most useful word at the post office:",["timbre","banque","poste","colis"],0,"Un timbre = a stamp. You'll buy stamps for letters constantly. Stamps for Canada Post mail differ by destination (local, USA, international).",1),
     mcq("Sending a package = un...",["timbre","colis","lettre","compte"],1,"Un colis = a package! You'll see this word at every package window. 'Envoyer un colis' = send a package. 'Recevoir un colis' = receive a package.",1),
     {type:"match",prompt:"Postal vocabulary",pairs:[["la poste","post office"],["un timbre","stamp"],["un colis","package"],["le code postal","postal code"],["par avion","airmail"]],explain:"Master these 5 to handle any postal need. Quebec postal codes are letters+numbers like H2X 1Y4 (Montreal).",diff:2},
     {type:"fill",before:"Je voudrais envoyer cette lettre",blank:"___",after:"avion à l'Inde. (by air)",options:["par","avec","de","en"],correct:0,explain:"Par avion! 'Par' = by (means of transport). Par avion = by plane. Par bateau = by boat. Par camion = by truck. The clerk will calculate cost based on destination.",diff:2},
     wr("Write 'I want to buy stamps'",["je voudrais acheter des timbres","acheter des timbres","des timbres s'il vous plaît"],"Je voudrais acheter des timbres! 'Des' for 'some' (multiple stamps). Practical request — you'll use it monthly!",2)]),
  mkL("a1-23","School & Daycare in Quebec",22,"speaking",
    "If you have kids in Quebec, you'll deal with schools (écoles) and daycares (garderies). Most are in French. You need to communicate with teachers, fill forms, attend meetings — all in French. Today you learn the vocabulary for navigating Quebec's education system.",
    ["l'école = the school","la garderie = daycare","la maternelle = kindergarten","l'enseignant(e) = teacher","le directeur / la directrice = principal","une réunion = a meeting","les devoirs = homework","le bulletin = report card","Mon enfant a... ans = My child is... years old","Quand commence l'année scolaire? = When does school start?"],
    [mcq("Quebec daycare =",["école","garderie","université","bibliothèque"],1,"Garderie! Quebec offers subsidized daycare ($8/day for many parents). 'CPE' (Centre de la Petite Enfance) is the most desired type. Apply EARLY for waitlists!",1),
     mcq("'Le bulletin de mon enfant' refers to:",["lunch box","report card","backpack","textbook"],1,"Report card! Bulletin = report card. Quebec parents receive 3 bulletins per school year. Important to read and discuss with your child.",2),
     {type:"match",prompt:"School vocabulary",pairs:[["l'école","school"],["la maternelle","kindergarten"],["les devoirs","homework"],["l'enseignante","teacher (fem)"],["le directeur","principal"]],explain:"5 essentials for school communication. Note: école starts age 6, maternelle is age 4-5. Daycare comes before that.",diff:2},
     {type:"fill",before:"Mon fils va à l'",blank:"___",after:"primaire. (primary school)",options:["école","garderie","collège","université"],correct:0,explain:"L'école primaire = primary/elementary school (grades 1-6 in Quebec). Then secondary (1-5), then CEGEP (2-3 years), then university.",diff:2},
     wr("Write 'My daughter is 5 years old'",["ma fille a 5 ans","ma fille a cinq ans","fille a 5 ans"],"Ma fille a 5 ans! Remember: age uses AVOIR, not ÊTRE. 'A' (has) not 'est' (is). At 5, your daughter would be ready for maternelle (kindergarten)!",2)]),
  mkL("a1-24","At the Library",18,"reading",
    "Quebec libraries (bibliothèques) are FREE and amazing — free books, internet, kids programs, even job-search help. You can borrow books in French and English. Today you learn the vocabulary for getting a library card and borrowing books at any Quebec municipal library.",
    ["la bibliothèque = library","un livre = a book","emprunter = to borrow","rendre = to return","une carte de bibliothèque = library card","gratuit = free","la durée = the duration","Combien de temps puis-je le garder? = How long can I keep it?","en retard = late","une amende = a fine"],
    [mcq("Library in French =",["bibliothèque","libraire","école","banque"],0,"Bibliothèque! NOT 'libraire' — that's a bookstore (where you BUY books). Bibliothèque = library (where you BORROW books). Common mistake for English speakers!",1),
     mcq("'Emprunter' means:",["to buy","to borrow","to read","to lend"],1,"Emprunter = to borrow. 'J'emprunte un livre' = I borrow a book. Verbe-trap: 'prêter' = to lend. Easy mix-up!",2),
     {type:"match",prompt:"Library terms",pairs:[["la bibliothèque","library"],["un livre","a book"],["emprunter","to borrow"],["rendre","to return"],["gratuit","free"]],explain:"5 library essentials. Tip: Quebec libraries also lend movies, music, even tools and games — all free!",diff:2},
     {type:"fill",before:"Je voudrais",blank:"___",after:"ce livre. (to borrow)",options:["lire","acheter","emprunter","rendre"],correct:2,explain:"Emprunter = to borrow. Polite phrase at any library counter. The librarian will scan your card and the book.",diff:2},
     wr("Write 'I want a library card'",["je voudrais une carte de bibliothèque","je voudrais une carte","une carte de bibliothèque"],"Je voudrais une carte de bibliothèque! Bring proof of address. The card is FREE for anyone living in Quebec. Lifetime access to thousands of resources!",2)]),
  mkL("a1-25","Government Services",22,"speaking",
    "From SAAQ (driver's license) to Service Canada, you'll deal with Quebec/Canadian government offices. Most operate primarily in French. Today you learn key phrases for booking appointments, asking for forms, and explaining your situation. These offices can be intimidating, but with the right phrases you'll handle them confidently.",
    ["un rendez-vous = an appointment","un formulaire = a form","la carte d'assurance maladie = health card","le permis de conduire = driver's license","le numéro d'assurance sociale (NAS) = SIN","une preuve de résidence = proof of residence","Quel document avez-vous besoin? = What document do you need?","Je voudrais prendre un rendez-vous = I'd like to book an appointment","la signature = signature","Veuillez patienter = Please wait"],
    [mcq("'Un formulaire' is:",["a stamp","a form","a card","a paper"],1,"Un formulaire = a form. You'll fill many forms in Quebec — rent, bank, health, school. Always ask: 'Avez-vous le formulaire en français?' if you need a translated version.",1),
     mcq("Most useful phrase at any government office:",["Help!","Bonjour, je voudrais prendre un rendez-vous","Open!","Goodbye"],1,"Bonjour, je voudrais prendre un rendez-vous! Almost all Quebec govt services are by appointment. Calling ahead is essential. Have your ID ready when you call.",2),
     {type:"match",prompt:"Government vocabulary",pairs:[["un rendez-vous","appointment"],["un formulaire","a form"],["la carte d'assurance maladie","health card"],["le permis","license/permit"],["la signature","signature"]],explain:"5 essentials for any govt office. Tip: Quebec health card (RAMQ) is essential — apply within 3 months of arriving!",diff:2},
     {type:"fill",before:"J'ai besoin de mon",blank:"___",after:"de conduire. (driver's license)",options:["carte","permis","NAS","passeport"],correct:1,explain:"Permis de conduire = driver's license. SAAQ (Société de l'assurance automobile du Québec) issues these. You may need a French driving test if you're from outside Canada.",diff:2},
     wr("Write 'I would like to make an appointment'",["je voudrais prendre un rendez-vous","prendre un rendez-vous","je voudrais un rendez-vous"],"Je voudrais prendre un rendez-vous! Universal phrase — works at any office, doctor, government service. Practice it — you'll need it weekly!",3)]),
  mkL("a1-26","Reading a Lease",22,"reading",
    "Signing a lease (un bail) is one of your biggest commitments in Quebec. The Tribunal administratif du logement (TAL) sets standard lease forms in French. You MUST understand what you're signing. Today you learn the key vocabulary in any Quebec lease — protecting yourself from problems later.",
    ["un bail = a lease","le locataire = tenant","le propriétaire = landlord","le loyer mensuel = monthly rent","les charges incluses = utilities included","la durée = duration/term","la date d'entrée = move-in date","une caution = security deposit","les réparations = repairs","résilier = to cancel/terminate"],
    [mcq("Lease in Quebec =",["un contrat","un bail","une location","un loyer"],1,"Un bail! Specifically a residential lease. The standard Quebec lease (bail TAL) is in French and English. ALWAYS read it carefully before signing.",1),
     mcq("Tenant =",["propriétaire","locataire","ami","voisin"],1,"Le locataire = tenant. Easy memory: 'location' (rental) → locataire (renter). Propriétaire = owner/landlord. Don't confuse them!",2),
     {type:"match",prompt:"Lease vocabulary",pairs:[["un bail","a lease"],["le locataire","tenant"],["le propriétaire","landlord"],["le loyer","rent"],["la caution","security deposit"]],explain:"5 lease essentials. Important: Quebec law forbids security deposits! If a landlord asks for one, that's illegal. Know your rights!",diff:3},
     {type:"fill",before:"Le bail est d'une",blank:"___",after:"de 12 mois. (duration)",options:["caution","durée","loyer","résiliation"],correct:1,explain:"Une durée = duration/term. Quebec leases default to 12 months. After that, they auto-renew. To not renew, you must give written notice 3-6 months ahead!",diff:3},
     wr("Write 'I am the tenant'",["je suis le locataire","je suis la locataire","locataire"],"Je suis le/la locataire! Use 'le' if you're male, 'la' if female. Important to identify yourself correctly when calling about your apartment.",2)]),
  mkL("a1-27","Phone Conversations",18,"speaking",
    "Phone conversations in French are HARD — no body language, accents harder to follow, must respond fast. Today you learn the standard phone phrases used in Quebec. From answering 'Allô?' to ending with 'Merci, au revoir!' — you'll handle any French phone call.",
    ["Allô? = Hello? (answering phone)","C'est qui à l'appareil? = Who's calling?","Pouvez-vous me passer...? = Can you connect me to...?","Un instant s'il vous plaît = One moment please","Je vais vous transférer = I'll transfer you","Pouvez-vous rappeler? = Can you call back?","Je laisse un message = I'm leaving a message","Merci, au revoir! = Thank you, goodbye!"],
    [mcq("Quebec way to answer the phone:",["Hello?","Allô?","Bonjour?","Oui?"],1,"Allô? Most common Quebec phone greeting. In France: 'Allô?' too. In professional settings: 'Bonjour, [Nom], j'écoute' (Hello, [Name], I'm listening).",1),
     mcq("'Un instant s'il vous plaît' means:",["I'm not sure","One moment please","Please call again","Goodbye"],1,"One moment please! Used to put someone on hold or while looking up info. Always say it warmly. The other person will appreciate not being left in silence.",2),
     {type:"match",prompt:"Phone phrases",pairs:[["Allô?","Answering"],["Un instant","Hold on"],["Je vous transfère","Transferring"],["Au revoir","Goodbye"],["Rappelez-moi","Call me back"]],explain:"5 essential phone phrases for any Quebec call. Practice them out loud — sounding confident on the phone is crucial!",diff:2},
     {type:"fill",before:"Bonjour, c'est",blank:"___",after:"Sara. Je voudrais parler à... (it's me, Sara)",options:["moi","ma","ja","je"],correct:0,explain:"C'est moi, Sara! 'Moi' = me, used to identify yourself. 'C'est moi qui appelle' = it's me calling. Useful when calling family/friends or returning a call.",diff:2},
     wr("Write 'Can you transfer me to Mr. Tremblay please?'",["pouvez-vous me transférer à monsieur tremblay","pouvez-vous me passer monsieur tremblay","monsieur tremblay s'il vous plaît"],"Pouvez-vous me transférer à Monsieur Tremblay s'il vous plaît? Polite, clear request. Receptionists love when you're polite and specific!",3)]),
  mkL("a1-28","Numbers Beyond 100",16,"listening",
    "Salaries, taxes, big purchases — you need numbers above 100. Hundreds, thousands, millions. French has special tricks: 200 = deux cents (with -s), 250 = deux cent cinquante (no -s before number). Today you master big numbers for any financial situation.",
    ["100 = cent | 200 = deux cents (with -s)","101 = cent un | 215 = deux cent quinze (no -s before another number)","1000 = mille (NEVER takes -s)","2000 = deux mille","10000 = dix mille","1 000 000 = un million (CAN take -s: deux millions)","Numbers are written: 1 200 in Canada, not 1,200","Read prices in cents: 1,99$ = un quatre-vingt-dix-neuf cents"],
    [mcq("How do you say 200?",["deux cent","deux cents","deux mille","deux centaines"],1,"Deux cents (with -s)! When 'cent' is alone (no number after it), it takes -s for plural: deux cents, trois cents, quatre cents.",2),
     mcq("How do you say 1500?",["mille cinq cents","mille cinq cent","quinze cent","mille cinq centaine"],0,"Mille cinq cents! Never 's' on mille (mille is invariable). Cents takes -s here because it's at the end (no number after). Common amount in rents and salaries!",3),
     {type:"match",prompt:"Number patterns",pairs:[["cent","100"],["deux cents","200"],["mille","1000"],["dix mille","10000"],["un million","1000000"]],explain:"5 milestone numbers for big amounts. Salary in Quebec: $40,000 = quarante mille dollars. House: $400,000 = quatre cent mille dollars.",diff:2},
     {type:"fill",before:"Le loyer est de",blank:"___",after:"dollars. (1500)",options:["mille cinq","mille cinq cents","quinze cents","cent cinq"],correct:1,explain:"Mille cinq cents! Or in spoken Quebec: 'quinze cents' (literally fifteen hundreds — also acceptable). For exact accuracy, use 'mille cinq cents'.",diff:3},
     wr("Write '$2500' in French numbers",["deux mille cinq cents","deux mille cinq cents dollars","2500"],"Deux mille cinq cents! Mille (no -s) + cinq cents (with -s, end of number). Common monthly rent in Montreal — be ready for these big numbers.",3)]),
  mkL("a1-29","Time Expressions — Past, Present, Future",18,"speaking",
    "Yesterday, today, tomorrow, last week, next month. Time expressions tell when something happens. French uses specific words and patterns that don't always translate directly. Today you master the most-used time expressions for talking about past, present, and future events.",
    ["aujourd'hui = today","hier = yesterday | demain = tomorrow","avant-hier = day before yesterday","après-demain = day after tomorrow","la semaine dernière = last week","la semaine prochaine = next week","ce matin = this morning","hier soir = last night/evening","tout à l'heure = a moment ago / in a moment","tout de suite = right now"],
    [mcq("Yesterday in French =",["aujourd'hui","hier","demain","avant"],1,"Hier! Pronounced 'YEHR' (silent H). 'Hier soir' = last night. 'Hier matin' = yesterday morning. Combine with time of day for precision!",1),
     mcq("'La semaine prochaine' means:",["last week","this week","next week","weekend"],2,"Next week! Prochain/prochaine = next. La semaine prochaine, le mois prochain, l'année prochaine. Memorize the pattern!",1),
     {type:"match",prompt:"Time expressions",pairs:[["aujourd'hui","today"],["hier","yesterday"],["demain","tomorrow"],["la semaine dernière","last week"],["ce matin","this morning"]],explain:"5 essentials for daily speech. Note: 'le matin' = the morning (general), 'ce matin' = this morning (specific).",diff:2},
     {type:"fill",before:"On va se voir",blank:"___",after:"prochain. (next month)",options:["la","ce","le mois","la semaine"],correct:2,explain:"Le mois prochain! Le mois (the month, masculine) + prochain (next). Pattern: le + time + prochain (next) or dernier (last).",diff:2},
     wr("Write 'I worked yesterday' (using passé composé)",["j'ai travaillé hier","hier j'ai travaillé","j'ai travaillé"],"J'ai travaillé hier! Or 'Hier, j'ai travaillé.' Time expression goes at start or end. Past tense (j'ai travaillé) + time word (hier) — perfect combination!",3)]),
  mkL("a1-30","Frequency Words — Always, Often, Never",16,"speaking",
    "How often do you do something? French has specific words for frequency: toujours (always), souvent (often), parfois (sometimes), jamais (never). They go in specific positions in sentences. Today you learn how to express frequency naturally.",
    ["toujours = always","souvent = often","parfois / quelquefois = sometimes","rarement = rarely","jamais = never (negative — use with ne)","ne...jamais = never (full negation)","tous les jours = every day","une fois par semaine = once a week","Position: usually after the verb","Je vais toujours au gym = I always go to the gym"],
    [mcq("How do you say 'always' in French?",["souvent","toujours","jamais","parfois"],1,"Toujours! Pronounced 'too-zhoor'. Position: usually after the verb. 'Je suis toujours fatigué' = I am always tired.",1),
     mcq("'Je ne mange jamais de viande' means:",["I always eat meat","I never eat meat","I rarely eat meat","I sometimes eat meat"],1,"I never eat meat! Jamais = never, but requires 'ne' before the verb (full negation). Pattern: ne + verb + jamais. Common phrase for vegetarians.",2),
     {type:"match",prompt:"Frequency words",pairs:[["toujours","always"],["souvent","often"],["parfois","sometimes"],["rarement","rarely"],["jamais","never"]],explain:"5 frequencies on a scale. Use them to describe your routines and habits. Add 'tous les jours' (daily), 'chaque semaine' (weekly) for specifics!",diff:2},
     {type:"fill",before:"Je vais",blank:"___",after:"fois par semaine au gym. (once)",options:["une","deux","jamais","souvent"],correct:0,explain:"Une fois par semaine = once a week. 'Une fois' = one time/once. 'Deux fois' = twice. Useful for stating frequency precisely.",diff:2},
     wr("Write 'I often eat fish' (poisson = fish)",["je mange souvent du poisson","je mange souvent poisson","souvent je mange poisson"],"Je mange souvent du poisson! Souvent goes after the verb. 'Du' = some (partitive). Now you can describe your eating habits in French!",3)]),
  mkL("a1-31","Adverbs — How You Do Things",18,"speaking",
    "Picture this: you're describing your new colleague to a friend. 'She speaks French quickly' — Elle parle vite. 'He drives slowly' — Il conduit lentement. Adverbs are the secret to vivid, expressive French. Most are formed by adding -ment to feminine adjectives (rapide → rapidement). Today you learn the pattern AND the most-used Quebec adverbs.",
    ["bien = well | mal = badly","vite / rapidement = fast/quickly","lentement = slowly","beaucoup = a lot","peu = little","trop = too much","assez = enough","Pattern: feminine adjective + -ment","heureuse → heureusement (happily)","sérieuse → sérieusement (seriously)"],
    [mcq("Pattern: complète + -ment =",["complétement","complètement","complete","completemnt"],1,"Complètement (completely)! Take feminine form (complète) + -ment. Most adverbs follow this pattern. 'Je suis complètement épuisé' = I'm completely exhausted.",2),
     mcq("'Il parle vite' means:",["He speaks well","He speaks fast","He speaks slowly","He speaks loudly"],1,"He speaks fast! 'Vite' = fast/quickly. More casual than 'rapidement'. Quebecers often say 'parle vite!' or 'pas si vite!' (not so fast).",1),
     {type:"match",prompt:"Match the adverb",pairs:[["bien","well"],["mal","badly"],["beaucoup","a lot"],["lentement","slowly"],["heureusement","happily/luckily"]],explain:"5 essential adverbs. 'Heureusement' is special — also means 'fortunately' or 'thankfully'. 'Heureusement, j'ai retrouvé mes clés!' = Thankfully I found my keys!",diff:2},
     {type:"fill",before:"Mon prof parle",blank:"___",after:"— je comprends tout. (slowly)",options:["vite","mal","lentement","souvent"],correct:2,explain:"Lentement = slowly. From feminine adjective 'lente' + -ment. The teacher speaks slowly so you understand. Hopefully YOUR teacher is just as patient!",diff:2},
     mcq("'Je travaille beaucoup' means:",["I work little","I work a lot","I work well","I work soon"],1,"I work a lot! 'Beaucoup' = a lot/much. Doesn't follow -ment pattern (irregular). After verbs, 'beaucoup' ALWAYS goes after the verb: 'Je mange beaucoup' (not 'Je beaucoup mange').",2),
     wr("Write 'I drive carefully' (carefully = prudemment)",["je conduis prudemment","conduis prudemment","prudemment je conduis"],"Je conduis prudemment! From 'prudent' → 'prudemment'. Adverbs ending in -emment/-amment come from adjectives ending in -ent/-ant. Subtle French pattern!",3)]),
  mkL("a1-32","Connector Words — Linking Your Ideas",18,"writing",
    "Imagine writing your first email to your child's teacher. 'My son is sick AND he can't come today BECAUSE he has a fever, BUT he should be back tomorrow.' Connectors transform simple sentences into real conversation. Today you learn the 8 most-used French connectors that will instantly make you sound more fluent.",
    ["et = and (joining ideas)","mais = but (contrast)","ou = or (alternative)","parce que = because (reason)","donc = so/therefore","alors = so/then","aussi = also","quand = when","pour = for / in order to","par exemple = for example"],
    [mcq("'Je suis fatigué __ je travaille beaucoup.' Connector?",["et","mais","parce que","ou"],2,"Parce que! 'I'm tired BECAUSE I work a lot.' Parce que introduces a reason. Quebecers also say 'pcq' in texts (abbreviation). Always followed by a clause (subject + verb).",1),
     mcq("'J'aime le café __ je n'aime pas le thé.'",["et","mais","ou","alors"],1,"Mais! 'I love coffee BUT I don't like tea.' Mais shows contrast. One of the most-used connectors — keeps speech natural and varied.",1),
     {type:"match",prompt:"Connector + meaning",pairs:[["et","and"],["mais","but"],["parce que","because"],["donc","therefore"],["aussi","also"]],explain:"5 essential connectors. Tip: 'donc' shows logical conclusion (therefore). 'Alors' is more conversational (so/then). Both work but in slightly different contexts!",diff:2},
     {type:"fill",before:"Sara va à l'épicerie",blank:"___",after:"acheter du lait. (in order to)",options:["et","pour","mais","parce que"],correct:1,explain:"Pour acheter du lait! 'Pour + infinitive' = in order to / to (purpose). Different from 'parce que' (which gives reason). Pour = goal/purpose.",diff:3},
     mcq("'Tu peux venir avec moi __ Mike?' (Or with Mike?)",["et","mais","ou","donc"],2,"Ou! 'Or' for alternatives. NOT 'où' (with accent — that means 'where'). One letter difference, totally different meanings!",2),
     wr("Connect: 'I'm tired AND I want to sleep' (dormir = sleep)",["je suis fatigué et je veux dormir","fatigué et veux dormir","je suis fatigué et veux dormir"],"Je suis fatigué et je veux dormir! 'Et' is the simplest connector — joining two clauses. Practice combining short sentences with et — instantly more fluent!",2)]),
  mkL("a1-33","Imperative — Giving Commands & Making Requests",20,"speaking",
    "Real-life moment: your child runs toward a busy street. 'Stop!' you shout. Or you're cooking with a friend: 'Pass me the salt please!' These are commands — and French has its own way to express them. The imperative is also crucial for recipes, instructions, polite requests. Today you master it for daily use.",
    ["Imperative form: drop subject pronoun (tu/vous/nous)","tu form: drop -s in -er verbs (Mange! NOT Manges!)","Vous form: same as present (Mangez!)","Nous form (let's): same as present (Mangeons!)","Polite request: 'Pourriez-vous...' (Could you...)","Negative imperative: Ne mange pas! (Don't eat!)","Common: Allez-y! Vas-y! (Go ahead!)","Recipe-style: Mélangez bien (Mix well)"],
    [mcq("Imperative of 'manger' (to eat) for 'tu' (informal you):",["Mange","Manges","Mangez","Mangeons"],0,"Mange! Drop the -s in -ER verb 'tu' imperative (mange, NOT manges). 'Mange tes légumes!' (Eat your vegetables!) — every Quebec parent says this!",2),
     mcq("'Allons au cinéma!' means:",["Go to the cinema","Let's go to the cinema","Are we going?","I want cinema"],1,"Let's go to the cinema! Nous form imperative = 'let's...'. 'Allons-y!' = Let's go (there)! Common Quebec phrase used dozens of times daily.",2),
     {type:"match",prompt:"Match imperative form",pairs:[["Mange!","Eat! (informal you)"],["Mangez!","Eat! (formal you)"],["Mangeons!","Let's eat!"],["Va-t'en!","Go away!"],["Tais-toi!","Be quiet!"]],explain:"5 imperative forms in action. Note: 'va-t'en' and 'tais-toi' include reflexive pronouns (-t-en, -toi). Used commonly in Quebec families!",diff:3},
     {type:"fill",before:"Madame, ",blank:"___",after:"-vous patienter? (Could you wait?)",options:["pouvez","pourriez","veux","faites"],correct:1,explain:"Pourriez! Conditional polite form. 'Pourriez-vous' = Could you... — much more polite than 'Pouvez-vous' (Can you). Use it in formal/professional contexts.",diff:3},
     mcq("How do you tell a child 'Don't run!'?",["Cours pas!","Ne cours pas!","Ne pas cours!","Pas cours!"],1,"Ne cours pas! Negative imperative: ne + verb + pas. Drop subject (tu). In casual speech you might hear 'Cours pas!' but proper French keeps the 'ne'.",2),
     wr("Tell a friend 'Come with me!' (venir = to come, informal)",["viens avec moi","viens avec moi!","viens"],"Viens avec moi! Imperative of 'venir' for tu = 'viens'. Drop the subject 'tu'. Friendly invitation that Quebecers love!",2)]),
  mkL("a1-34","Future with Aller — What I'm Going To Do",18,"speaking",
    "Your boss asks: 'What are your weekend plans?' You want to say 'I'm going to visit my friends' — Je vais visiter mes amis. The 'futur proche' (near future) uses ALLER + infinitive — easy and used CONSTANTLY. Today you master this go-to future tense for any near-future plan.",
    ["Pattern: aller + infinitive = going to + verb","Je vais manger = I'm going to eat","Tu vas étudier = You're going to study","Il/elle va travailler = He/she's going to work","Nous allons partir = We're going to leave","Vous allez voir = You're going to see","Ils/elles vont arriver = They're going to arrive","Negation: Je ne vais pas... (I'm not going to...)","Time markers: demain, ce soir, la semaine prochaine"],
    [mcq("'I'm going to call my mom' = ",["Je téléphone ma mère","Je vais téléphoner à ma mère","Je vais téléphoner ma mère","J'allais téléphoner"],1,"Je vais téléphoner à ma mère! Pattern: aller (conjugated) + infinitive (téléphoner). 'Téléphoner À' (don't forget the À!). Express future plans naturally.",2),
     mcq("'Demain, on va au cinéma' means:",["Yesterday we went to cinema","Tomorrow we're going to cinema","We're at cinema","Let's go to cinema"],1,"Tomorrow we're going to cinema! 'On va' = we're going. With 'demain' (tomorrow), it's clearly future. Quebecers say 'on va' instead of 'nous allons' constantly.",2),
     {type:"match",prompt:"Match futur proche",pairs:[["Je vais","I'm going to"],["Tu vas","You're going to"],["Il/Elle va","He/She's going to"],["Nous allons","We're going to"],["Ils/Elles vont","They're going to"]],explain:"All 6 forms of aller + infinitive = futur proche. Easier than the 'simple future' tense. Use this for any 'going to' meaning.",diff:1},
     {type:"fill",before:"Ce soir, je",blank:"___",after:"manger au restaurant. (am going to)",options:["va","vais","vas","allons"],correct:1,explain:"Je vais manger! 'Vais' is je form of aller. The infinitive 'manger' stays unconjugated. Pattern: subject + aller (conjugated) + infinitive (unchanged).",diff:2},
     mcq("Negative: 'I'm NOT going to work tomorrow'",["Je vais ne pas travailler","Je ne vais pas travailler","Je ne pas vais travailler","Je vais pas travail"],1,"Je ne vais pas travailler demain! Pattern: ne + aller + pas + infinitive. Same negation as present tense — wraps around the conjugated verb (vais), not the infinitive.",3),
     wr("Write 'I'm going to study tonight' (étudier = study)",["je vais étudier ce soir","ce soir je vais étudier","vais étudier ce soir"],"Je vais étudier ce soir! Or 'Ce soir, je vais étudier.' Both work. Time word at start adds emphasis. Now you can talk about future plans easily!",2)]),
  mkL("a1-35","Weekend & Free Time",18,"speaking",
    "Friday afternoon at work: a colleague asks 'Tu fais quoi cette fin de semaine?' (What are you doing this weekend?). You need to talk about your hobbies and plans. Today you learn the vocabulary for weekend activities, hobbies, and casual social conversations — the small talk that builds real friendships in Quebec.",
    ["la fin de semaine = weekend (Quebec) | le weekend (France)","sortir = to go out","les loisirs = hobbies/leisure","faire du sport = play sports","regarder un film = watch a movie","aller au parc = go to the park","faire des courses = run errands","se reposer = to rest","Tu fais quoi? = What are you doing?","On y va? = Shall we go?"],
    [mcq("'Cette fin de semaine' means:",["this Friday","this weekend","this evening","this week"],1,"This weekend! In Quebec we say 'fin de semaine' (literally 'end of week'). In France they say 'le weekend'. Cultural difference — use 'fin de semaine' to fit in!",1),
     mcq("'Je fais du sport' means:",["I'm tired","I play sports","I'm sleeping","I'm cooking"],1,"I play sports! 'Faire du + sport' is a fixed expression. Faire du yoga, faire du ski, faire du tennis. With 'jouer' for some sports: 'jouer au hockey' (play hockey). Quebec sport — hockey is huge!",2),
     {type:"match",prompt:"Weekend activities",pairs:[["sortir","go out"],["faire du sport","play sports"],["regarder un film","watch a movie"],["aller au parc","go to the park"],["se reposer","rest"]],explain:"5 common weekend activities. Mix and match for your weekend small talk. 'Je vais sortir et regarder un film' (I'm going out and watching a movie).",diff:2},
     {type:"fill",before:"Cette fin de semaine, je vais",blank:"___",after:"un film. (watch)",options:["voir","regarder","écouter","sortir"],correct:1,explain:"Regarder! 'Regarder un film' = watch a movie. 'Voir un film' also works (see a movie). Both common in Quebec. 'Écouter' is for music or radio.",diff:2},
     mcq("Casual Quebec way to ask 'What are you doing this weekend?'",["Que faites-vous?","Tu fais quoi cette fin de semaine?","Vous allez où?","Comment ça va?"],1,"Tu fais quoi cette fin de semaine? Casual, friendly. Quebecers love this question — use it with friends and colleagues to start conversations!",2),
     wr("Write 'I'm going to rest' (se reposer)",["je vais me reposer","me reposer","je me repose"],"Je vais me reposer! 'Se reposer' is reflexive (self verb). For 'I rest', use 'me' (self). Tu te reposes, il se repose. Reflexive verbs are everywhere in French!",3)]),
  mkL("a1-36","Job Hunting in Quebec",22,"reading",
    "You're job hunting in Montreal. The CV (CV) is in French. The interview is in French. The job posting (offre d'emploi) is in French. Today's lesson covers the essential phrases for job hunting in Quebec — from reading job postings to nailing the basic interview phrases. After this lesson you'll handle French job applications confidently.",
    ["un emploi / un travail = a job","une offre d'emploi = job posting","un CV = resume","une lettre de motivation = cover letter","un entretien = an interview","l'expérience = experience","les compétences = skills","l'employeur = employer","postuler = to apply","être embauché = to be hired"],
    [mcq("Cover letter in French =",["CV","lettre de motivation","entretien","emploi"],1,"Lettre de motivation! Always required with applications in Quebec. 'CV + lettre de motivation' is the standard set. The lettre explains WHY you want THIS specific job.",1),
     mcq("'Je voudrais postuler' means:",["I would like to apply","I want a job","I have a job","I work here"],0,"I would like to apply! 'Postuler' = to apply (for a job). 'Je postule' (I'm applying), 'Je voudrais postuler' (I'd like to apply). Sounds professional!",2),
     {type:"match",prompt:"Job hunting vocabulary",pairs:[["un emploi","a job"],["un entretien","interview"],["les compétences","skills"],["postuler","to apply"],["embauché","hired"]],explain:"5 essential terms for the job search. Note: 'embauché' (masc), 'embauchée' (fem) — agree with you! Common to hear 'Je viens d'être embauché' (I just got hired)!",diff:2},
     {type:"fill",before:"Quelle est votre",blank:"___",after:"professionnelle? (experience)",options:["expérience","compétence","emploi","CV"],correct:0,explain:"Expérience! Common interview question. Be ready to summarize your past jobs in French: 'J'ai travaillé chez X pendant 3 ans' (I worked at X for 3 years).",diff:2},
     mcq("How do you describe yourself in an interview?",["Je suis ponctuel et organisé","Travail bon","Bonjour je suis","Je veux job"],0,"Je suis ponctuel et organisé! Use simple positive adjectives: ponctuel, organisé, motivé, travailleur, fiable. Always agree by gender (ponctuelle, organisée etc. for women).",2),
     wr("Write 'I'm interested in this position' (poste = position)",["je suis intéressé par ce poste","je suis intéressée par ce poste","intéressé par ce poste"],"Je suis intéressé(e) par ce poste! Add -e if you're female (intéressée). Strong opener for a cover letter or interview. Shows enthusiasm professionally!",3)]),
  mkL("a1-37","Talking About Your Past — Where You Came From",22,"speaking",
    "At a Quebec immigrant gathering, everyone shares their story. 'I came from India two years ago.' 'I was an engineer in Mumbai.' 'I learned French here in Montreal.' Today you learn how to tell YOUR story in French — past experiences, where you came from, what you did before. Critical for making real connections in your new home.",
    ["Je viens de [country] = I'm from [country]","Je suis arrivé(e) en [year] = I arrived in [year]","Avant, je... = Before, I...","Dans mon pays = In my country","J'ai habité à... = I lived in...","Mon ancien travail = My old job","J'ai immigré au Canada = I immigrated to Canada","Je m'habitue à la vie ici = I'm getting used to life here","Quelle est votre histoire? = What's your story?","C'est différent ici = It's different here"],
    [mcq("'Je viens de l'Inde' means:",["I love India","I'm from India","I'm going to India","I miss India"],1,"I'm from India! 'Venir de + country' = to come from. 'Je viens de l'Inde, du Canada, de la France'. Note: de l' before vowels, du for masculine, de la for feminine.",1),
     mcq("'J'ai habité à Mumbai pendant 25 ans' means:",["I will live in Mumbai for 25 years","I lived in Mumbai for 25 years","I'm going to Mumbai for 25 years","I love Mumbai for 25 years"],1,"I lived in Mumbai for 25 years! 'Pendant + duration' = for [duration]. Past form 'j'ai habité' = I lived. Common phrase for sharing your background.",2),
     {type:"match",prompt:"Past life vocabulary",pairs:[["Je viens de","I'm from"],["J'ai habité","I lived"],["Avant","Before"],["mon ancien","my former/old"],["dans mon pays","in my country"]],explain:"5 essential phrases for sharing your past. Combine them: 'Avant, j'habitais en Inde et j'étais ingénieur' (Before, I lived in India and was an engineer).",diff:2},
     {type:"fill",before:"Je suis arrivé au Canada il y a deux",blank:"___",after:". (years)",options:["semaines","mois","ans","jours"],correct:2,explain:"Ans! 'Il y a [time]' = [time] ago. 'Il y a deux ans' = two years ago. Useful when telling your immigration story to new friends.",diff:2},
     mcq("How do you say 'I was an engineer in India'?",["Je suis ingénieur en Inde","J'étais ingénieur en Inde","Je vais être ingénieur","Je veux être ingénieur"],1,"J'étais ingénieur en Inde! 'Étais' = was (imparfait — used for past states). 'En + country (no article for some)'. Quebec values immigrants' professional backgrounds — share yours!",3),
     wr("Write 'I came to Canada in 2024'",["je suis arrivé au canada en 2024","je suis arrivée au canada en 2024","arrivé au canada en 2024"],"Je suis arrivé(e) au Canada en 2024! Add -e if female. 'Au Canada' (au for masculine country). Common starter for sharing your immigration story.",3)]),
  mkL("a1-38","Speaking Practice — Real Conversations",22,"speaking",
    "Imagine you're at a Quebec coffee shop, alone, when a friendly local sits next to you and starts chatting. Your heart pounds — but you remember everything you've learned. Today's lesson SIMULATES that real conversation. You'll practice REAL responses to REAL questions. After this you'll feel ready for actual French chat with strangers.",
    ["Tu viens d'où? = Where are you from?","Ça fait combien de temps que tu es ici? = How long have you been here?","Tu aimes le Québec? = Do you like Quebec?","C'est dur, le français? = Is French hard?","Tu travailles dans quoi? = What do you do for work?","T'as des enfants? = Do you have kids?","Tu connais beaucoup de monde ici? = Do you know many people here?","C'est pas mal, hein? = Not bad, huh?","Bienvenue au Québec! = Welcome to Quebec!","On se reverra! = We'll see each other again!"],
    [mcq("Reply to 'Tu viens d'où?':",["Je viens d'Inde","J'aime","Je sais","Je vais"],0,"Je viens d'Inde! Or your country: Je viens des Philippines, du Maroc, de la Chine. Use 'de' for feminine, 'du' for masculine, 'des' for plural country.",1),
     mcq("'Ça fait deux ans que je suis ici.' Reply means:",["I've been here 2 years","I'll be here 2 years","I came 2 years","I'm leaving 2 years"],0,"I've been here 2 years! 'Ça fait + duration + que' = It's been [duration] that... Common Quebec sentence structure for time spans.",2),
     {type:"match",prompt:"Match question to natural answer",pairs:[["Tu viens d'où?","Je viens de l'Inde"],["Tu aimes le Québec?","Oui, beaucoup!"],["C'est dur le français?","Au début oui, mais ça va!"],["Tu travailles dans quoi?","Je suis comptable"],["T'as des enfants?","Oui, deux"]],explain:"5 typical opening conversation pairs. Memorize natural responses for each. They'll come up at every social event!",diff:2},
     {type:"fill",before:"Ça fait six mois",blank:"___",after:"je suis au Canada. (that)",options:["et","mais","que","si"],correct:2,explain:"Que! 'Ça fait + duration + que + clause' = It's been [duration] that [clause]. Standard Quebec phrasing. 'Ça fait 6 mois que je suis au Canada' = I've been in Canada for 6 months.",diff:3},
     mcq("Quebec local says 'Bienvenue au Québec!' Best response:",["Merci beaucoup!","Bonjour","Au revoir","Pourquoi?"],0,"Merci beaucoup! Warm appreciation for the warm welcome. Could add: 'Merci, je suis content(e) d'être ici' (Thanks, I'm happy to be here)!",1),
     wr("Reply to 'Tu travailles dans quoi?' — say you're a teacher (enseignant/enseignante)",["je suis enseignante","je suis enseignant","enseignant","enseignante"],"Je suis enseignant(e)! Add -e if female. Or use your own profession: ingénieur(e), infirmier/infirmière, médecin, comptable. Useful for any social conversation!",3)]),
  mkL("a1-39","Writing Practice — Texts, Emails, Notes",18,"writing",
    "Real situation: your child's teacher emails about a meeting. You need to reply in French. Or you're texting a Quebec friend about plans. Or writing a note to your landlord. Today you practice WRITING in French — short, clear, polite messages that handle everyday communication.",
    ["Bonjour [Name], = Hello [Name],","Bonjour Madame/Monsieur, = Formal Hello","Cordialement, = Kind regards (formal)","Merci d'avance = Thanks in advance","Salut! = Hi! (informal)","À bientôt = See you soon","Pourrais-je...? = Could I...?","Je vous remercie = I thank you (formal)","P.S. = same in French","Bonne journée! = Have a good day!"],
    [mcq("Formal email greeting (to teacher you don't know well):",["Salut!","Bonjour Madame,","Hi!","Allô!"],1,"Bonjour Madame! Formal but warm. Use 'Madame' (for women) or 'Monsieur' (for men) when you don't know the name. NEVER use first name with 'Madame'.",2),
     mcq("'Cordialement' is used for:",["text to friend","formal email closing","greeting","goodbye in person"],1,"Formal email closing! Equivalent to 'Best regards'. Use it in any professional/formal email. For friends, 'Bisous' or 'À +' works better.",2),
     {type:"match",prompt:"Email phrases",pairs:[["Bonjour Madame","Formal greeting"],["Cordialement","Formal closing"],["Merci d'avance","Thanks in advance"],["Salut!","Casual hi"],["À bientôt","See you soon"]],explain:"5 essential email phrases. Mix and match for any context. 'Bonjour' + 'Cordialement' for formal. 'Salut' + 'À bientôt' for friends.",diff:2},
     {type:"fill",before:"Bonjour Madame Tremblay,\\n\\nJe voudrais",blank:"___",after:"un rendez-vous. (book)",options:["prendre","faire","aller","manger"],correct:0,explain:"Prendre un rendez-vous = to book/take an appointment. Polite request: 'Je voudrais prendre un rendez-vous'. Common in any professional email.",diff:2},
     mcq("Casual text to a friend ending:",["Cordialement","Sincèrement","À +","Veuillez agréer"],2,"À +! Short for 'à plus tard' (see you later). Pure Quebec text-speak. Other casual closings: 'Bisous' (kisses), 'Salut!' (bye), 'Bonne soirée!' (have a good evening).",2),
     wr("Write a polite request: 'Could you confirm the meeting please?' (réunion = meeting)",["pourriez-vous confirmer la réunion s'il vous plaît","pourriez-vous confirmer la réunion","confirmer la réunion s'il vous plaît"],"Pourriez-vous confirmer la réunion s'il vous plaît? Polite, professional French. 'Pourriez-vous' (Could you) + verb + 's'il vous plaît'. Universal polite formula!",3)]),
  mkL("a1-40","A1 Final Assessment — Show Your Skills!",30,"mixed",
    "You've made it through 40 lessons. From greeting strangers to making future plans, from describing yourself to navigating Quebec life — you can do it ALL in French. Today's final lesson tests EVERYTHING you've learned with mixed real-life scenarios. Pass this and you're CLB 1-2 ready, prepared for A2!",
    ["Greetings: Bonjour, Salut, Bonsoir","Polite phrases: S'il vous plaît, Merci, Excusez-moi","Self-intro: Je m'appelle, J'ai X ans, Je viens de","Numbers, time, dates","Family, weather, body parts","Past tense (passé composé)","Future tense (aller + infinitif)","Pronouns (le, la, lui, leur, y, en)","Connectors (et, mais, parce que, donc)","Quebec expressions: dépanneur, magasiner, fin de semaine"],
    [mcq("You meet a Quebec colleague's parents. Most polite greeting:",["Salut!","Bonjour Madame, bonjour Monsieur","Hey!","Allô!"],1,"Bonjour Madame, bonjour Monsieur! Always 'Madame/Monsieur' for elders or formal situations. Add a smile and a slight nod — perfect Quebec etiquette!",1),
     mcq("Best way to politely interrupt to ask a question:",["Hey!","Excusez-moi, j'ai une question","One question","Stop"],1,"Excusez-moi, j'ai une question. Polite, professional, gets attention without being rude. Use this in meetings, classes, any formal situation.",2),
     {type:"match",prompt:"Match the situation",pairs:[["Buying coffee","Je voudrais un café s'il vous plaît"],["Asking time","Quelle heure est-il?"],["Saying you're cold","J'ai froid"],["Saying you don't understand","Je ne comprends pas"],["Saying goodbye warmly","Bonne journée!"]],explain:"5 essentials for daily life. You've mastered them all! Use these phrases CONFIDENTLY — Quebecers will appreciate your effort and respond warmly.",diff:2},
     {type:"fill",before:"Hier soir, j'ai",blank:"___",after:"un film français. (watched)",options:["regardé","manger","aller","fait"],correct:0,explain:"Regardé! Past participle of regarder. 'J'ai regardé' = I watched. Past tense + film + en français = perfect French sentence about your evening!",diff:2},
     mcq("Future plans: 'I'm going to study French this evening':",["J'étudie","J'ai étudié","Je vais étudier","Je vais étudie"],2,"Je vais étudier le français ce soir! Pattern: aller (vais) + infinitive (étudier). Talking about your evening study plan — perfect natural French!",2),
     {type:"scene",story:"At a Quebec networking event, you meet someone for the first time. They say 'Bonjour, Stéphane Tremblay, enchanté!' What's a perfect response?",prompt:"Most natural Quebec response:",options:["Bonjour, [your name], enchanté(e)! Je suis ravi(e) de vous rencontrer.","Hello!","Bonjour.","Au revoir!"],correct:0,explain:"Bonjour, [your name], enchanté(e)! Je suis ravi(e) de vous rencontrer = Hello, [name], delighted! I'm pleased to meet you. Warm, professional, perfectly Quebec!",diff:3},
     {type:"order",prompt:"Build a complete sentence: 'I would like to thank you for your help'",words:["Je","voudrais","vous","remercier","pour","votre","aide"],answer:["Je","voudrais","vous","remercier","pour","votre","aide"],explain:"Je voudrais vous remercier pour votre aide! Polite, professional, complete. 'Vous remercier' = to thank you (formal). Use this in emails or formal speech!",diff:3},
     wr("Write a complete introduction: name, age, country, city, profession",["je m'appelle","j'ai","je viens","j'habite","je suis"],"Je m'appelle [name]. J'ai [age] ans. Je viens de [country]. J'habite à [city]. Je suis [profession]. CONGRATULATIONS — you've completed A1! You can now communicate in French about yourself, your life, your past, your future, and basic daily situations. Welcome to A2!",3)]),
];

const A2_LESSONS = [
  mkL("a2-01","At the Bank",25,"speaking",
    "Opening a bank account is one of the first things you do in Canada. The teller speaks French, the forms are in French, and you need to explain what you need. Today you learn everything for your first bank visit — how to open an account, understand your statement, transfer money, and talk to your banker. These skills save you money and stress every month.",
    ["Je voudrais ouvrir un compte = I would like to open an account","un compte chèques = a chequing account","un compte épargne = a savings account","un virement = a transfer","un dépôt = a deposit","un retrait = a withdrawal","le solde = the balance","les frais = the fees","une hypothèque = a mortgage","le taux d'intérêt = the interest rate"],
    [mcq("You want to open an account. You say:",["Je voudrais ouvrir un compte s'il vous plaît","Je veux de l'argent","Combien coûte un compte?","Je voudrais un virement"],0,"Je voudrais ouvrir un compte = I would like to open an account. This is the exact phrase bank tellers in Quebec expect. Always add s'il vous plaît — it makes a great first impression!",1),
     mcq("The teller asks about your 'solde'. What is she asking about?",["Your salary","Your balance","Your fees","Your transfer"],1,"Le solde = the balance! Quel est votre solde? = What is your balance? You'll see this on every bank statement and ATM screen. Essential word for managing money in Canada!",1),
     {type:"match",prompt:"Match the banking term to its meaning",pairs:[["un virement","a transfer"],["un dépôt","a deposit"],["un retrait","a withdrawal"],["le solde","the balance"],["les frais","the fees"]],explain:"These 5 words appear on every bank statement in Quebec. Learn them and you'll never be confused by your Desjardins or TD statement again!",diff:1},
     {type:"fill",before:"Je voudrais faire",blank:"___",after:"de 500 dollars vers mon autre compte.",options:["un virement","un retrait","un dépôt","une hypothèque"],correct:0,explain:"Un virement = a transfer. Je voudrais faire un virement = I would like to make a transfer. This is what you say when sending money between accounts or to another person in Quebec.",diff:2},
     mcq("The banker says 'Il y a des frais mensuels de 15 dollars'. What does this mean?",["Your balance is $15","There is a $15 monthly fee","You need to deposit $15","Your interest rate is 15%"],1,"Des frais mensuels = monthly fees. Frais = fees/charges, mensuels = monthly. Always ask 'Quels sont les frais?' before opening any account — fees vary between banks!",2),
     {type:"scene",story:"Sara goes to Desjardins to open her first Canadian bank account. The teller says 'Bonjour! Qu'est-ce que je peux faire pour vous aujourd'hui?'",prompt:"What should Sara say?",options:["Je voudrais ouvrir un compte chèques s'il vous plaît","Bonjour je suis Sara","Je voudrais de l'argent","Où est le guichet automatique?"],correct:0,explain:"Je voudrais ouvrir un compte chèques s'il vous plaît — perfect! Compte chèques = chequing account (the most common first account in Canada). Polite, clear, and professional!",diff:2},
     {type:"order",prompt:"Ask: What are the monthly fees for this account?",words:["Quels","sont","les","frais","mensuels","pour","ce","compte?"],answer:["Quels","sont","les","frais","mensuels","pour","ce","compte?"],explain:"Quels sont les frais mensuels pour ce compte? — a smart question every new Canadian should ask before signing up for any bank account. Knowledge saves money!",diff:2},
     wr("Write how you would ask for your account balance in French",["quel est mon solde","mon solde","je voudrais voir mon solde","quel est le solde"],"Quel est mon solde? Simple and clear! Bank tellers and ATMs all use this word. You can also say 'Je voudrais voir mon solde' = I would like to see my balance. You are ready for any Quebec bank!",2)]),

  mkL("a2-02","Reading Your Lease",25,"reading",
    "You found an apartment in Quebec — congratulations! But now you have to sign a bail (lease) and it's all in French. This is a legally binding document and understanding it is crucial. Missing a clause could cost you your deposit or lead to eviction. Today you learn the most important lease vocabulary so you never sign something you don't understand.",
    ["le bail = the lease","le propriétaire = the landlord","le locataire = the tenant","le loyer mensuel = monthly rent","le dépôt de garantie = security deposit","les charges = utilities/charges","la durée du bail = lease duration","le préavis = notice period","les animaux de compagnie = pets","les réparations = repairs"],
    [mcq("In a lease, who is the 'locataire'?",["The landlord","The building manager","The tenant","The real estate agent"],2,"Le locataire = the tenant — that's YOU! Le propriétaire = the landlord. Knowing this distinction is essential — the lease has different obligations for each party. Régie du logement protects tenants in Quebec!",1),
     mcq("The lease says 'préavis de 60 jours'. What does this mean?",["You must pay 60 days deposit","You need to give 60 days notice before leaving","The lease lasts 60 days","Rent increases every 60 days"],1,"Préavis = notice period. In Quebec, you typically need to give 3 months notice (préavis de 3 mois) before leaving. 60 days is sometimes negotiated. ALWAYS check this clause!",1),
     {type:"match",prompt:"Match the lease term to its meaning",pairs:[["le bail","the lease"],["le propriétaire","the landlord"],["le locataire","the tenant"],["le loyer mensuel","monthly rent"],["le préavis","notice period"]],explain:"These are the 5 most important words in any Quebec lease. Understanding them means you know your rights and obligations as a tenant in Canada!",diff:1},
     {type:"fill",before:"Le",blank:"___",after:"est de 1200 dollars par mois, payable le premier du mois.",options:["loyer mensuel","préavis","bail","dépôt"],correct:0,explain:"Le loyer mensuel = the monthly rent. Payable le premier du mois = payable on the first of the month. This is the standard rent payment schedule in Quebec — always on the 1st!",diff:2},
     mcq("The lease says 'animaux de compagnie non admis'. What does this mean?",["Pets are welcome","Pets are not allowed","Small pets only","Ask the landlord about pets"],1,"Non admis = not allowed/admitted. Animaux de compagnie non admis = pets not allowed. This is very common in Quebec leases. If you have a pet, look for 'animaux admis' or negotiate before signing!",2),
     {type:"scene",story:"Ravi is reading his new lease. He sees: 'Durée du bail: 12 mois, du 1er juillet au 30 juin. Loyer: 1150$/mois. Charges incluses: eau chaude. Préavis: 3 mois.'",prompt:"What does Ravi now know about his lease?",options:["12-month lease July to June, $1150/month, hot water included, 3 months notice required","6-month lease, $1150/month, all utilities included, 2 months notice","12-month lease, $1150 + utilities, 3 months notice, starting August","1-year lease, $1,150 weekly, water not included"],correct:0,explain:"Durée 12 mois = 12-month lease. 1er juillet au 30 juin = July 1 to June 30 (Quebec's moving day is July 1!). Loyer 1150$/mois = $1,150/month. Eau chaude incluse = hot water included. Préavis 3 mois = 3 months notice. You read a real French lease!",diff:3},
     {type:"order",prompt:"Build: The rent is payable on the first of each month",words:["Le","loyer","est","payable","le","premier","de","chaque","mois"],answer:["Le","loyer","est","payable","le","premier","de","chaque","mois"],explain:"Le loyer est payable le premier de chaque mois — this exact phrase appears in almost every Quebec lease. Chaque = each/every. Premier = first. Now you can read and understand your lease!",diff:2},
     wr("Write how you ask your landlord about pet policy in French",["animaux","les animaux sont","est-ce que les animaux","les animaux de compagnie"],"Est-ce que les animaux de compagnie sont admis? — asking before signing saves you from future conflict. In Quebec, tenant rights are strong — but it's always better to clarify in writing!",2)]),

  mkL("a2-03","Your Pay Stub",25,"reading",
    "You got your first Canadian paycheck — exciting! But the talon de paie (pay stub) is full of confusing French words: cotisations, retenues, RPC, AE... What was deducted? What do you actually take home? Today you learn to read your pay stub completely. This is money you earned — you deserve to understand every line of it.",
    ["le salaire brut = gross salary","le salaire net = net salary (take-home)","les retenues = deductions","l'impôt sur le revenu = income tax","le RPC = CPP (Canada Pension Plan)","l'AE = EI (Employment Insurance)","les heures supplémentaires = overtime","la période de paie = pay period","le talon de paie = pay stub","les avantages sociaux = benefits"],
    [mcq("What is 'salaire net' on your pay stub?",["Your gross salary before deductions","Your take-home pay after deductions","Your overtime pay","Your benefits"],1,"Salaire net = net salary = your actual take-home pay after all deductions. Salaire brut = gross salary before deductions. The difference can be 25-35% in Canada — taxes, CPP, and EI add up!",1),
     mcq("'RPC' on your pay stub stands for:",["Régime de Paie Canadien","Régime de Pensions du Canada (CPP)","Retenue Pour Congés","Revenu Personnel Calculé"],1,"RPC = Régime de Pensions du Canada = Canada Pension Plan (CPP). This is deducted from every paycheck. You'll get this money back as pension when you retire in Canada — it's an investment in your future!",1),
     {type:"match",prompt:"Match the pay stub term to its meaning",pairs:[["salaire brut","gross salary"],["salaire net","take-home pay"],["les retenues","deductions"],["l'AE","Employment Insurance"],["heures supplémentaires","overtime"]],explain:"These 5 terms appear on every Canadian pay stub. Understanding them means you can verify your pay is correct — and spot errors before they cost you money!",diff:1},
     {type:"fill",before:"Mon salaire brut est 3000$ mais mon salaire",blank:"___",after:"est 2200$ après les retenues.",options:["net","brut","mensuel","annuel"],correct:0,explain:"Salaire net = take-home pay after deductions. The difference between brut (3000$) and net (2200$) = 800$ in deductions (impôt, RPC, AE, etc.). Always check that your net matches what's deposited in your bank!",diff:2},
     mcq("Your pay stub shows 'AE: 45.32$'. What is this?",["A bonus","Employment Insurance deduction","A fee for benefits","Overtime pay"],1,"AE = Assurance-Emploi = Employment Insurance. This is deducted each paycheck. The benefit? If you ever lose your job, you can claim AE payments for up to 45 weeks. It protects you!",2),
     {type:"scene",story:"Amara gets her first pay stub. It shows: Salaire brut: 2,800$. Retenues: Impôt: 420$, RPC: 141$, AE: 52$. Salaire net: 2,187$.",prompt:"How much does Amara actually take home?",options:["$2,800","$2,187","$613","$2,759"],correct:1,explain:"Salaire net = 2,187$ — that's what Amara takes home! Retenues totales = 420+141+52 = 613$ in deductions. Impôt (income tax) is always the biggest deduction. Now you can verify your own pay stub!",diff:2},
     {type:"order",prompt:"Build: My gross salary is 3000 dollars per month",words:["Mon","salaire","brut","est","de","3000","dollars","par","mois"],answer:["Mon","salaire","brut","est","de","3000","dollars","par","mois"],explain:"Mon salaire brut est de 3000 dollars par mois — this is how you state your salary in French. You'll need this phrase at the bank (for a mortgage), on rental applications, and in job negotiations!",diff:2},
     wr("Write how you would ask your employer about a pay stub error in French",["il y a une erreur","erreur dans mon salaire","mon salaire net","je voudrais vérifier"],"Il y a une erreur dans mon talon de paie — I would like to verify. Knowing this phrase protects your income. In Quebec, employers must correct pay errors. You have rights!",2)]),

  mkL("a2-04","School Registration in Quebec",25,"mixed",
    "Registering your children in a Quebec school — or yourself in a French class — is one of the most important tasks for new immigrants. Forms, interviews with administrators, understanding the school system. The Quebec school system is unique: primaire, secondaire, cégep, université. Today you master school vocabulary and can handle any school registration in French.",
    ["l'école primaire = elementary school (ages 5-12)","l'école secondaire = high school (ages 12-17)","le cégep = college (unique to Quebec, ages 17-19)","l'université = university","le bulletin = report card","le conseil scolaire = school board","la garderie = daycare","le CPE = subsidized daycare (Centre de la Petite Enfance)","l'inscription = registration","les fournitures scolaires = school supplies"],
    [mcq("What age do children start école primaire in Quebec?",["3","5","6","7"],1,"École primaire starts at age 5 in Quebec (not 6 like some provinces). It goes from maternelle (kindergarten) through grade 6. French instruction is mandatory in Quebec public schools!",1),
     mcq("What is unique about 'cégep' in Quebec?",["It's a private school","It's between high school and university — unique to Quebec","It's another word for university","It's an elementary school"],1,"Cégep = Collège d'enseignement général et professionnel. It's 2-3 years between secondaire (high school) and université. FREE in Quebec! This unique system means Quebec university is shorter (3 years instead of 4). A great advantage!",1),
     {type:"match",prompt:"Match the Quebec school level to description",pairs:[["la garderie","daycare for young children"],["l'école primaire","elementary school"],["l'école secondaire","high school"],["le cégep","college between HS and university"],["l'université","university"]],explain:"Quebec's school system is unique in Canada! Understanding these levels helps you navigate registration, explain your children's level, and plan your own education path in Quebec.",diff:1},
     {type:"fill",before:"Je voudrais inscrire mon fils à",blank:"___",after:"primaire pour septembre.",options:["l'école","le cégep","le bulletin","la garderie"],correct:0,explain:"Je voudrais inscrire mon fils à l'école primaire = I would like to enroll my son in elementary school. Inscrire = to enroll/register. This is the exact phrase you use at a school office in Quebec!",diff:2},
     mcq("What is a CPE in Quebec?",["A private school","A subsidized daycare (Centre de la Petite Enfance)","A school board","A university program"],1,"CPE = Centre de la Petite Enfance = subsidized daycare! Quebec's CPE system offers high-quality daycare for around $10-15/day (heavily subsidized by the government). Very popular — register as soon as you arrive because waitlists are long!",2),
     {type:"scene",story:"Priya arrives at an école primaire to register her 6-year-old daughter. The secretary says 'Bonjour! Vous êtes ici pour une inscription?' (Are you here to register?)",prompt:"What should Priya say?",options:["Oui, je voudrais inscrire ma fille en première année s'il vous plaît","Oui je veux école","Bonjour mon enfant a 6 ans","Je ne comprends pas"],correct:0,explain:"Oui, je voudrais inscrire ma fille en première année s'il vous plaît — perfect! Première année = grade 1 (age 6). Ma fille = my daughter. S'il vous plaît shows respect. The secretary will guide you through the rest!",diff:2},
     {type:"order",prompt:"Say: I would like to register my child for September",words:["Je","voudrais","inscrire","mon","enfant","pour","septembre"],answer:["Je","voudrais","inscrire","mon","enfant","pour","septembre"],explain:"Je voudrais inscrire mon enfant pour septembre — used at schools, daycares, and activity programs. School registration in Quebec typically opens in March-April for the following September!",diff:2},
     wr("Write how you ask when registration opens for next year",["quand","l'inscription","quand est-ce que","inscriptions pour"],"Quand est-ce que les inscriptions ouvrent pour l'année prochaine? — a practical question every parent in Quebec needs to ask. Early registration means you get your preferred school or daycare!",2)]),

  mkL("a2-05","Government Services in French",30,"mixed",
    "In Canada, every interaction with the government happens in French in Quebec. Service Canada, CRA (Agence du revenu), RAMQ, SAAQ — all your important cards and services go through French-language offices. Today you learn to navigate government services: make appointments, understand letters, fill forms, and assert your rights. This knowledge makes you a confident Canadian.",
    ["Service Canada = federal employment/benefits office","la RAMQ = Quebec health insurance (carte d'assurance maladie)","la SAAQ = Quebec driver's licence and car registration","l'ARC / CRA = Canada Revenue Agency (taxes)","le NAS = Social Insurance Number (SIN)","la carte d'assurance maladie = health card","le permis de conduire = driver's licence","la déclaration de revenus = tax return","un formulaire = a form","Veuillez remplir = Please fill out"],
    [mcq("What does RAMQ stand for and what does it provide?",["Roads and transportation","Quebec health insurance — your free healthcare card","Employment benefits","Driving licence"],1,"RAMQ = Régie de l'assurance maladie du Québec. This is Quebec's health insurance — your carte d'assurance maladie (health card) comes from RAMQ. Apply within 3 months of arriving — healthcare is free with this card!",1),
     mcq("'Veuillez remplir ce formulaire' means:",["Please sign this form","Please fill out this form","Please return this form","Please read this form"],1,"Veuillez remplir = please fill out. Remplir = to fill. Formulaire = form. You'll see this on every government form in Quebec. After filling: 'Veuillez signer' (please sign) and 'Veuillez retourner' (please return).",1),
     {type:"match",prompt:"Match the government agency to its role",pairs:[["RAMQ","health insurance card"],["SAAQ","driver's licence"],["CRA / ARC","income taxes"],["Service Canada","employment insurance"],["NAS","Social Insurance Number"]],explain:"These 5 agencies handle the most important aspects of Canadian life. Knowing what each does saves you from going to the wrong office — and long waits in Quebec government offices!",diff:1},
     {type:"fill",before:"Je voudrais renouveler ma",blank:"___",after:"d'assurance maladie s'il vous plaît.",options:["carte","formulaire","déclaration","permis"],correct:0,explain:"Je voudrais renouveler ma carte d'assurance maladie = I would like to renew my health card. Renouveler = to renew. Your RAMQ card must be renewed every few years — this is the phrase you say at the office!",diff:2},
     mcq("A letter from CRA says 'Vous devez produire votre déclaration de revenus avant le 30 avril'. What must you do?",["Apply for health insurance before April 30","File your tax return before April 30","Renew your SIN before April 30","Pay your fees before April 30"],1,"Produire votre déclaration de revenus = file your tax return. The April 30 deadline applies to everyone in Canada. 'Vous devez' = you must. Missing this date means penalties — this letter is urgent!",2),
     {type:"scene",story:"Ravi receives a letter from Service Canada in French. It says: 'Veuillez vous présenter à notre bureau avec votre NAS et une pièce d'identité pour compléter votre demande d'assurance-emploi.'",prompt:"What does Ravi need to do?",options:["Go to the office with his SIN and ID to complete his EI application","Mail his health card to Service Canada","Call Service Canada about his tax return","Bring his driver's licence to renew it"],correct:0,explain:"Présentez-vous = go to the office. NAS = Social Insurance Number. Pièce d'identité = ID. Demande d'assurance-emploi = EI application. You just understood a real government letter in French — this is huge!",diff:3},
     {type:"order",prompt:"Say: I need to renew my driver's licence",words:["Je","dois","renouveler","mon","permis","de","conduire"],answer:["Je","dois","renouveler","mon","permis","de","conduire"],explain:"Je dois renouveler mon permis de conduire — I must renew my driver's licence. Go to SAAQ for this. Je dois = I must (from devoir). This phrase works for any renewal: carte d'assurance maladie, passeport, permis de travail!",diff:2},
     wr("Write how you would say you need to apply for your health card",["je voudrais","la carte d'assurance maladie","faire une demande","demander ma carte"],"Je voudrais faire une demande de carte d'assurance maladie — apply for RAMQ within 3 months of arriving in Quebec. With this card, all doctor visits and hospital care are FREE. One of the best benefits of living in Canada!",2)]),

  mkL("a2-06","Advanced Job Interview",30,"speaking",
    "You have experience now. You've been in Canada for a while. You want a better job — maybe in your field, maybe a promotion. Advanced French job interviews require more than basic phrases. You need to discuss your career history, explain complex situations, negotiate salary, and present yourself as a true professional. Today you master the language of career advancement.",
    ["Mon parcours professionnel = my professional background","J'ai travaillé pendant X ans dans = I worked for X years in","Mes responsabilités incluaient = My responsibilities included","J'ai géré une équipe de = I managed a team of","Je suis à l'aise avec = I am comfortable with","Quelles sont les perspectives d'avancement? = What are the advancement opportunities?","Le salaire est-il négociable? = Is the salary negotiable?","Je cherche un poste où = I am looking for a position where","Mes objectifs professionnels = my professional goals","À quoi ressemble une journée typique? = What does a typical day look like?"],
    [mcq("The interviewer asks 'Parlez-moi de votre parcours professionnel'. What should you do?",["Describe your education only","Give a complete overview of your work history and experience","Talk about your hobbies","Discuss your salary expectations"],1,"Parcours professionnel = professional background/career path. Give a 2-3 minute overview: where you studied, where you worked, what you achieved. Start with the most recent and work backward. This is the most important question in any French job interview!",1),
     mcq("How do you ask if the salary is negotiable?",["C'est combien le salaire?","Le salaire est-il négociable?","Je veux plus d'argent","Quel est le salaire minimum?"],1,"Le salaire est-il négociable? — professional and direct. In Quebec, it's normal to negotiate! Most employers expect it. If they say 'oui, c'est négociable', you can counter-offer with 'Je pensais à quelque chose autour de X dollars'.",2),
     {type:"match",prompt:"Match the interview phrase to its meaning",pairs:[["Mon parcours professionnel","my career background"],["J'ai géré une équipe","I managed a team"],["Mes objectifs professionnels","my professional goals"],["À l'aise avec","comfortable with"],["Perspectives d'avancement","advancement opportunities"]],explain:"These 5 phrases elevate your French interview from basic to professional. Using them shows the interviewer you are serious, prepared, and comfortable in a French work environment.",diff:2},
     {type:"fill",before:"J'ai travaillé pendant cinq ans",blank:"___",after:"le secteur de la santé au Québec.",options:["dans","avec","pour","à"],correct:0,explain:"J'ai travaillé pendant cinq ans dans le secteur de la santé = I worked for five years in the healthcare sector. Dans = in (for sectors/fields). J'ai travaillé dans la construction, dans l'éducation, dans la finance.",diff:2},
     mcq("The interviewer asks 'Quelles sont vos forces et vos faiblesses?' What is she asking?",["What are your years of experience?","What are your strengths and weaknesses?","What are your salary expectations?","What are your work hours?"],1,"Forces et faiblesses = strengths and weaknesses. The classic interview question in French! Prepare 3 forces (strengths) with examples, and 1 faiblesse that is actually a strength in disguise (e.g., 'Je suis perfectionniste'). Always end on a positive note!",2),
     {type:"scene",story:"Sara is interviewing for a marketing manager position. The interviewer says 'Vous avez géré des équipes dans votre pays d'origine — comment vous adapteriez-vous au contexte québécois?'",prompt:"What is the interviewer asking?",options:["How Sara would adapt her team management to the Quebec context","Why Sara left her previous job","How large Sara's team was","What Sara's salary was in her home country"],correct:0,explain:"Comment vous adapteriez-vous = how would you adapt (conditional tense — polite/hypothetical). Contexte québécois = Quebec context. This question tests cultural adaptability — a key concern for employers hiring immigrants. Show you've researched Quebec workplace culture!",diff:3},
     {type:"order",prompt:"Say: I am looking for a position where I can develop my skills",words:["Je","cherche","un","poste","où","je","peux","développer","mes","compétences"],answer:["Je","cherche","un","poste","où","je","peux","développer","mes","compétences"],explain:"Je cherche un poste où je peux développer mes compétences — shows ambition and motivation! Compétences = skills/competencies. Où = where (relative pronoun). This phrase impresses French-speaking interviewers every time.",diff:3},
     wr("Write a sentence describing your main professional strength in French",["je suis","ma force principale","mon point fort","je suis doué","je suis compétent"],"Excellent professional French! Describing your strengths confidently in French is what separates candidates in Quebec job interviews. Practice saying this out loud until it flows naturally.",2)]),

  mkL("a2-07","Talking to Your Neighbours",20,"speaking",
    "Your neighbour knocks on your door. Someone at the bus stop wants to chat. The parent at your child's school starts a conversation. Small talk in Quebec is warm, friendly, and very Canadian. Today you learn how to have natural conversations about weather, neighbourhood, family, and daily life. These conversations build the community connections that make Canada feel like home.",
    ["Il fait beau aujourd'hui! = Beautiful day today!","Vous habitez ici depuis longtemps? = Have you lived here long?","Vous avez des enfants? = Do you have children?","C'est tranquille par ici = It's quiet around here","Qu'est-ce que vous faites dans la vie? = What do you do for work?","D'où venez-vous? = Where are you from?","Comment trouvez-vous le Québec? = How do you find Quebec?","On s'adapte! = We're adapting!","Les hivers sont longs! = The winters are long!","Bienvenue dans le quartier! = Welcome to the neighbourhood!"],
    [mcq("Your neighbour says 'Il fait beau aujourd'hui!' How do you respond?",["Je ne comprends pas","Oui, c'est magnifique! Il fait chaud pour la saison.","Non","Je voudrais parler"],1,"Oui, c'est magnifique! Il fait chaud pour la saison = Yes, it's magnificent! It's warm for the season. Weather small talk is THE most common conversation starter in Quebec. Always agree, add something, then ask them a question to keep the conversation going!",1),
     mcq("Someone asks 'Comment trouvez-vous le Québec?' What is a good answer?",["Je ne sais pas","Je trouve le Québec très accueillant! Les gens sont gentils.","C'est froid","Je suis d'Inde"],1,"Je trouve le Québec très accueillant! Les gens sont gentils = I find Quebec very welcoming! People are kind. Trouvez-vous = do you find (formal). Accueillant = welcoming. Quebecers love hearing positive things about their province — it opens doors!",1),
     {type:"match",prompt:"Match the small talk phrase to its meaning",pairs:[["Il fait beau!","Beautiful weather!"],["Vous habitez ici depuis longtemps?","Have you lived here long?"],["Bienvenue dans le quartier!","Welcome to the neighbourhood!"],["Les hivers sont longs!","The winters are long!"],["On s'adapte!","We're adapting!"]],explain:"These 5 phrases are the foundation of Quebec neighbourhood conversations. Master them and you'll make friends, build community, and feel at home much faster. Quebecers are warm people!",diff:1},
     {type:"fill",before:"Qu'est-ce que vous",blank:"___",after:"dans la vie? (What do you do for work?)",options:["faites","êtes","avez","prenez"],correct:0,explain:"Qu'est-ce que vous faites dans la vie? = What do you do for work/in life? Faites = do (from faire). This is the most common 'getting to know you' question in Quebec. Reply: Je suis infirmière, Je travaille dans la construction, Je suis aux études.",diff:2},
     mcq("Your neighbour asks 'Vous avez des enfants?' You have 2 children. You say:",["Non","Oui, j'ai deux enfants. Un garçon de 8 ans et une fille de 5 ans.","Je ne sais pas","Peut-être"],1,"Oui, j'ai deux enfants — then add details! Ages, names, schools. This is the most natural conversation bridge. Quebec parents love talking about their children. Sharing this creates instant connection with neighbours!",2),
     {type:"scene",story:"Amara meets her neighbour Marie in the hallway. Marie says 'Bonjour! Vous êtes nouvelle dans l'immeuble? Je m'appelle Marie, j'habite au 3ème. Bienvenue dans le quartier!'",prompt:"How should Amara respond to be friendly and natural?",options:["Merci beaucoup! Je m'appelle Amara, j'habite au 4ème. Je suis arrivée le mois dernier. C'est un beau quartier!","Oui","Je ne parle pas français","Au revoir"],correct:0,explain:"Merci beaucoup! Je m'appelle Amara — introduce yourself! J'habite au 4ème = I live on the 4th floor. Je suis arrivée le mois dernier = I arrived last month. C'est un beau quartier = it's a nice neighbourhood. Natural, warm, and very Quebec!",diff:2},
     {type:"order",prompt:"Say: I've been living in this neighbourhood for 6 months",words:["J'habite","dans","ce","quartier","depuis","six","mois"],answer:["J'habite","dans","ce","quartier","depuis","six","mois"],explain:"J'habite dans ce quartier depuis six mois — depuis + present tense for ongoing situations. Ce quartier = this neighbourhood. Say this to new neighbours and they'll immediately feel comfortable — you're part of the community!",diff:2},
     wr("Write what you would say to introduce yourself to a new neighbour",["je m'appelle","j'habite","je suis arrivé","bienvenue","je suis nouveau"],"A warm neighbourly introduction in French! In Quebec, knocking on your neighbour's door to introduce yourself is totally normal and appreciated. Your French skills make this possible!",2)]),

  mkL("a2-08","Health System Navigation",25,"mixed",
    "Quebec's healthcare system is excellent but confusing for newcomers. RAMQ, CLSCs, walk-in clinics, specialists, emergency rooms — where do you go? How do you get a family doctor? What do you do when you can't find one? Today you learn to navigate the entire Quebec healthcare system in French, from finding a doctor to understanding your rights as a patient.",
    ["le CLSC = community health centre (local healthcare)","la clinique sans rendez-vous = walk-in clinic","le médecin de famille = family doctor","un spécialiste = a specialist","une référence = a referral","la liste d'attente = waiting list","Guichet d'accès à un médecin de famille = registry for those without a family doctor","les urgences = emergency room","une consultation = an appointment/consultation","Je n'ai pas de médecin de famille = I don't have a family doctor"],
    [mcq("You need a doctor but have no family doctor. Where do you go first?",["The emergency room","The CLSC or a walk-in clinic (clinique sans rendez-vous)","A specialist","The hospital"],1,"Clinique sans rendez-vous = walk-in clinic (literally: clinic without appointment). CLSCs also offer walk-in services. Emergency rooms (urgences) are for true emergencies only — going there for minor issues means 6-8 hours of waiting!",1),
     mcq("What is the 'Guichet d'accès à un médecin de famille'?",["A hospital emergency service","The provincial registry to get a family doctor","A walk-in clinic","A specialist referral service"],1,"The Guichet d'accès = Quebec's official registry for people without a family doctor. Register at guichetacces.ramq.gouv.qc.ca — it's free and managed by RAMQ. You'll be matched with a family doctor based on your location. Do this as soon as you arrive!",1),
     {type:"match",prompt:"Match the healthcare term to its meaning",pairs:[["le CLSC","community health centre"],["les urgences","emergency room"],["une référence","a referral"],["la liste d'attente","waiting list"],["médecin de famille","family doctor"]],explain:"These 5 terms are essential for navigating Quebec healthcare. Knowing them means you go to the RIGHT place the FIRST time — saving hours of waiting and unnecessary stress.",diff:1},
     {type:"fill",before:"Je n'ai pas de médecin de famille. Je voudrais m'inscrire au",blank:"___",after:"d'accès à un médecin de famille.",options:["Guichet","CLSC","urgence","spécialiste"],correct:0,explain:"Guichet d'accès à un médecin de famille — this is the system to get a family doctor in Quebec. Say this at a CLSC or RAMQ office and they will guide you to register. It's free and you have the right to a family doctor!",diff:2},
     mcq("The doctor says you need 'une référence à un spécialiste'. What happens next?",["You go directly to a specialist","The doctor writes you a referral to see a specialist","You go to the emergency room","You need to pay for the specialist"],1,"Une référence = a referral. The family doctor refers you to a specialist. In Quebec, specialist visits are free with RAMQ but you need a referral (you can't just book a specialist directly). Keep your referral letter!",2),
     {type:"scene",story:"Priya calls a CLSC. The receptionist says 'Nous n'avons pas de rendez-vous disponibles aujourd'hui, mais notre clinique sans rendez-vous ouvre à 8h demain matin. Arrivez tôt — les places sont limitées.'",prompt:"What should Priya do?",options:["Arrive early tomorrow morning at 8am for the walk-in clinic","Call back tomorrow for an appointment","Go to the emergency room tonight","Wait for a callback"],correct:0,explain:"Clinique sans rendez-vous ouvre à 8h = walk-in clinic opens at 8am. Arrivez tôt = arrive early. Places limitées = limited spots. In Quebec, walk-in clinics fill up fast — arriving 30 minutes early is the strategy!",diff:2},
     {type:"order",prompt:"Say: I need to make an appointment with a specialist",words:["J'ai","besoin","d'un","rendez-vous","avec","un","spécialiste"],answer:["J'ai","besoin","d'un","rendez-vous","avec","un","spécialiste"],explain:"J'ai besoin d'un rendez-vous avec un spécialiste — you'll say this when your doctor refers you. J'ai besoin de = I need. The receptionist will take it from there and schedule you!",diff:2},
     wr("Write how you would describe not having a family doctor and needing help",["je n'ai pas de médecin","médecin de famille","je cherche un médecin","je suis sans médecin"],"Je n'ai pas de médecin de famille et je cherche de l'aide — this honest statement gets you the right help at any CLSC. Quebec health workers are trained to help newcomers. Don't hesitate to ask!",2)]),

  mkL("a2-09","Passé Composé vs Imparfait",30,"writing",
    "Two past tenses that confuse even advanced French learners: passé composé and imparfait. But here's the secret — they tell different kinds of stories. Passé composé = what happened (specific events). Imparfait = what was happening (background, habits, descriptions). Think of a movie: the passé composé is the action, the imparfait is the setting. Today you master both — and telling stories becomes natural.",
    ["Passé composé = completed actions: J'ai mangé (I ate)","Imparfait = background/habits: Je mangeais (I was eating / I used to eat)","PC for specific events: Il est arrivé à 8h (He arrived at 8)","IMP for descriptions: Il faisait beau (The weather was nice)","IMP for interrupted actions: Je dormais quand... (I was sleeping when...)","PC interrupts IMP: ...quand le téléphone a sonné (when the phone rang)","IMP for habits: Quand j'étais jeune, je jouais (When I was young, I played)","Key IMP words: toujours, souvent, d'habitude, chaque jour","Key PC words: soudain, tout à coup, un jour, hier","Être imparfait: j'étais, tu étais, il était, nous étions, vous étiez, ils étaient"],
    [mcq("'Hier, je __ au restaurant.' Which tense for a completed action?",["mangeais (imparfait)","ai mangé (passé composé)","mange (présent)","mangerais (conditionnel)"],1,"J'ai mangé = passé composé! Hier (yesterday) signals a specific completed action. Passé composé = things that happened at a specific time and are finished. Hier, j'ai mangé au restaurant = Yesterday I ate at a restaurant.",1),
     mcq("'Quand j'étais enfant, je __ au parc tous les jours.' Which tense?",["suis allé","vais","allais (imparfait)","irai"],2,"J'allais au parc = imparfait! 'Tous les jours' (every day) signals a habit or repeated action. Imparfait for habits, routines, and repeated past actions. Quand j'étais enfant = when I was a child (also imparfait for ongoing state).",1),
     {type:"match",prompt:"Match the time expression to the correct tense",pairs:[["Hier soudain","passé composé"],["D'habitude","imparfait"],["Tout à coup","passé composé"],["Chaque matin","imparfait"],["Un jour","passé composé"]],explain:"Time expressions are your clues! Soudain, tout à coup, un jour, hier = passé composé (specific events). D'habitude, chaque jour, toujours, souvent = imparfait (habits/routines). Learn these signal words!",diff:2},
     {type:"fill",before:"Je",blank:"___",after:"(dormir-IMP) quand le téléphone a sonné. (I was sleeping when the phone rang.)",options:["dormais","ai dormi","dors","dormirais"],correct:0,explain:"Je dormais (imparfait) = I was sleeping — the background action. Quand le téléphone a sonné (passé composé) = when the phone rang — the interrupting event. This PC interrupts IMP pattern is used constantly in French storytelling!",diff:2},
     mcq("Which sentence correctly uses both tenses?",["Il faisait beau quand je suis sorti","Il a fait beau quand je sortais","Il faisait beau quand je faisais une promenade","Il a fait beau quand il a fait chaud"],0,"Il faisait beau (IMP — description/background) quand je suis sorti (PC — specific action that happened). Background in imparfait, event in passé composé. This structure is the foundation of French storytelling!",3),
     {type:"scene",story:"Sara is telling her neighbour about her weekend: 'Samedi, il faisait très beau. Je me promenais dans le parc quand j'ai rencontré mon ancien professeur de français. Nous avons parlé pendant une heure!'",prompt:"Identify the correct use of tenses in Sara's story",options:["Faisait/promenais = IMP (background/ongoing), ai rencontré/avons parlé = PC (specific events)","All verbs should be in passé composé","Faisait = PC, promenais = IMP, rencontré = IMP","All verbs should be in imparfait"],correct:0,explain:"Perfect tense usage! Il faisait beau (IMP = weather description), je me promenais (IMP = ongoing action), quand j'ai rencontré (PC = specific event), nous avons parlé (PC = completed conversation). This is exactly how native French speakers tell stories!",diff:3},
     {type:"order",prompt:"Build: I was working when my boss called",words:["Je","travaillais","quand","mon","patron","a","appelé"],answer:["Je","travaillais","quand","mon","patron","a","appelé"],explain:"Je travaillais (IMP — ongoing background) quand mon patron a appelé (PC — specific interrupting event). This sentence structure appears constantly in French conversation. Master it and your storytelling becomes fluent!",diff:3},
     wr("Write 2 sentences about something that happened to you — use both imparfait and passé composé",["je","quand","il faisait","j'étais","soudain","tout à coup","puis"],"Using both tenses in the same story shows real French fluency! The contrast between IMP (setting/background) and PC (events) is what makes French storytelling rich and natural. Keep practicing this — it becomes automatic!",3)]),

  mkL("a2-10","Writing Formal Emails in French",25,"writing",
    "In Quebec, professional communication happens by email — and French business emails have very specific conventions. The opening, the closing, the level of formality — all different from English. Getting this right means you look professional and competent. Getting it wrong can hurt your career or business relationships. Today you master formal French email writing that impresses Quebec professionals.",
    ["Objet: = Subject:","Bonjour Madame/Monsieur, = Dear Madam/Sir (formal opening)","Je me permets de vous contacter = I am writing to contact you","Suite à notre conversation = Following our conversation","Je vous prie d'agréer = Please accept (formal closing formula)","Veuillez trouver en pièce jointe = Please find attached","Dans l'attente de votre réponse = Awaiting your reply","Cordialement = Best regards (semi-formal)","Je vous salue distinguément = Yours faithfully (very formal)","N'hésitez pas à me contacter = Don't hesitate to contact me"],
    [mcq("How do you open a formal French email to someone you don't know?",["Salut!","Hey,","Bonjour Madame Tremblay,","Cher ami,"],2,"Bonjour Madame/Monsieur + last name = the standard formal French email opening in Quebec. Never 'Salut' (too informal) or 'Cher/Chère' (outdated and overly formal). Bonjour is perfect — professional, warm, and modern.",1),
     mcq("What does 'Veuillez trouver en pièce jointe' mean?",["Please call me","Please find attached","Please reply soon","Please sign this"],1,"Veuillez trouver en pièce jointe = please find attached. Pièce jointe = attachment. This phrase appears in virtually every professional French email with attachments. Always check your attachment is actually attached before sending!",1),
     {type:"match",prompt:"Match the email phrase to its meaning",pairs:[["Bonjour Madame,","Dear Madam,"],["Je me permets de vous contacter","I am writing to you"],["Veuillez trouver en pièce jointe","Please find attached"],["Dans l'attente de votre réponse","Awaiting your reply"],["Cordialement","Best regards"]],explain:"These 5 phrases are the building blocks of every professional French email. Master them and your written French communication will look completely professional to any Quebec employer or client!",diff:1},
     {type:"fill",before:"Suite à notre entretien téléphonique,",blank:"___",after:"vous faire parvenir mon CV et ma lettre de motivation.",options:["je vous prie de","j'aimerais","je voudrais","je peux"],correct:0,explain:"Je vous prie de = I would like to / I request (very formal). Suite à = following. This opening shows you remember the conversation and are following up professionally. Perfect for job applications!",diff:2},
     mcq("Which is the correct formal email closing in French?",["À plus!","Bisous","Je vous prie d'agréer, Madame, l'expression de mes salutations distinguées","Bonne chance!"],2,"Je vous prie d'agréer... l'expression de mes salutations distinguées — the classic formal French closing. For semi-formal: 'Cordialement'. For less formal but still professional: 'Bien à vous'. Never use casual closings in professional emails!",2),
     {type:"scene",story:"Priya needs to email her landlord about a broken heater. She writes: 'Objet: Problème de chauffage — urgent. Bonjour Monsieur Lavoie, Je me permets de vous contacter au sujet d'un problème urgent dans mon appartement. Le système de chauffage est en panne depuis hier soir. Pourriez-vous envoyer un technicien dans les meilleurs délais? Dans l'attente de votre réponse, je vous salue cordialement. Priya Sharma'",prompt:"What makes this email professionally appropriate?",options:["Formal opening (Bonjour Monsieur), clear subject, polite request (Pourriez-vous), professional closing (cordialement)","It uses tu instead of vous","It starts with Salut which is friendly","It doesn't use any formal phrases"],correct:0,explain:"Priya's email is perfect! Clear subject (Objet), formal opening (Bonjour Monsieur + last name), polite request using conditionnel (Pourriez-vous), formal closing (cordialement). This is exactly how Quebec professionals communicate!",diff:3},
     {type:"order",prompt:"Build the email closing: Awaiting your reply, best regards",words:["Dans","l'attente","de","votre","réponse,","cordialement,"],answer:["Dans","l'attente","de","votre","réponse,","cordialement,"],explain:"Dans l'attente de votre réponse, cordialement — a perfect semi-formal email closing. This combination of 'awaiting your reply' + 'best regards' is used in thousands of Quebec professional emails every day!",diff:2},
     wr("Write the opening line of a formal email asking for a job interview",["je me permets","bonjour","je vous contacte","suite à","je souhaite","postuler"],"Bonjour Madame/Monsieur, Je me permets de vous contacter concernant le poste de [title] publié sur [platform]. — This opening gets you noticed! Professional, direct, and perfectly formal. Your French business writing is at a professional level now!",3)]),

  mkL("a2-11","French for the Workplace",25,"speaking",
    "You're at work in Quebec. Your boss gives instructions in French. Your coworkers chat at lunch. There's a team meeting — all in French. Workplace French is different from textbook French: faster, more casual, with Quebec expressions. Today you learn the language of the Quebec workplace so you can participate, contribute, and advance in your career.",
    ["la réunion = the meeting","le compte rendu = the meeting minutes/summary","la tâche = the task","l'échéance = the deadline","le collègue = the colleague","le gestionnaire = the manager","la formation = training","les ressources humaines = HR","je suis en train de = I am in the process of","Pouvez-vous m'expliquer? = Can you explain to me?"],
    [mcq("Your manager says 'La réunion est à 10h dans la salle de conférence'. What should you do?",["Go to the cafeteria at 10","Go to the conference room at 10 for the meeting","Call your manager at 10","Email the team at 10"],1,"Réunion = meeting, salle de conférence = conference room. Simple and direct! In Quebec workplaces, punctuality for meetings is important. Arrive 2-3 minutes early and say Bonjour to everyone!",1),
     mcq("Your coworker asks 'Tu es en train de finir le rapport?' What are they asking?",["Did you finish the report?","Are you in the process of finishing the report?","When will you start the report?","Who wrote the report?"],1,"Je suis en train de = I am in the process of / I am currently. En train de finir = in the process of finishing. This expression is used constantly in Quebec workplaces to describe ongoing tasks!",1),
     {type:"match",prompt:"Match the workplace term to its meaning",pairs:[["la réunion","the meeting"],["l'échéance","the deadline"],["le compte rendu","meeting summary"],["la formation","training"],["les ressources humaines","HR"]],explain:"These 5 workplace terms come up in every Quebec office. Know them and you'll follow team conversations, understand emails, and participate confidently in meetings!",diff:1},
     {type:"fill",before:"Je suis en train",blank:"___",after:"terminer le projet avant l'échéance.",options:["de","à","pour","avec"],correct:0,explain:"Je suis en train de + infinitif = I am currently doing something. En train de terminer = currently finishing. This expression is essential for workplace French — it shows what you're working on right now!",diff:2},
     mcq("Your manager says 'Pouvez-vous préparer le compte rendu de la réunion?' What does she want?",["Prepare the meeting agenda","Write the meeting summary/minutes","Book the meeting room","Email the team about the meeting"],1,"Compte rendu = meeting minutes/summary. Préparer le compte rendu = to prepare the meeting summary. This is often assigned to a team member after each meeting. A key skill in any Quebec office!",2),
     {type:"scene",story:"Ravi is in his first team meeting in Montreal. His manager says 'Ravi, pouvez-vous nous présenter l'avancement de votre projet?' Everyone looks at him.",prompt:"What does Ravi need to do?",options:["Give a status update on his project","Introduce himself to the team","Ask about the meeting agenda","Say he doesn't understand"],correct:0,explain:"L'avancement du projet = the progress/advancement of the project. Présenter = to present. Ravi needs to give a brief project status update — in French! Start with: 'Le projet avance bien. Nous avons complété...' Practice this for your next meeting!",diff:2},
     {type:"order",prompt:"Say: I am currently working on the monthly report",words:["Je","suis","en","train","de","travailler","sur","le","rapport","mensuel"],answer:["Je","suis","en","train","de","travailler","sur","le","rapport","mensuel"],explain:"Je suis en train de travailler sur le rapport mensuel — this is the most natural way to say you're working on something in French. Mensuel = monthly. Use this phrase in any workplace status update!",diff:2},
     wr("Write how you would tell your manager you need more time to finish a task",["j'ai besoin","plus de temps","je ne peux pas","l'échéance","terminer"],"J'ai besoin de plus de temps pour terminer cette tâche — I need more time to finish this task. Being able to communicate this professionally in French shows maturity and respect for your manager. Quebec workplaces value clear communication!",2)]),

  mkL("a2-12","Quebec French vs France French",20,"listening",
    "You've been learning French — but sometimes Quebecers say things you've never heard! That's because Quebec French has its own expressions, pronunciation, and vocabulary that differ from France French. This isn't bad — it's fascinating! Today you learn the most important Quebec-specific expressions so you understand what people actually say on the streets of Montreal.",
    ["Bonjour vs Allô (Quebec greeting)","Char = voiture (car)","Bouffe = nourriture (food — informal)","Magasiner = faire du shopping (to go shopping)","Dépanneur (dép) = convenience store (uniquely Quebec!)","Tuque = winter hat","Pogner = attraire / attraper (to catch/get)","C'est le boutte! = C'est super! (It's great!)","Avoir de la misère = avoir du mal (to have difficulty)","Tantôt = tout à l'heure (shortly/earlier)"],
    [mcq("A Quebecer says 'Je vais au dépanneur'. Where are they going?",["The grocery store","The department store","The convenience store","The gas station"],2,"Le dépanneur (or just 'le dép') = convenience store! This is a uniquely Quebec institution — open late, sells milk, chips, beer, lottery tickets. Every Quebec neighbourhood has one. Understanding this word helps you fit in instantly!",1),
     mcq("Your Quebec friend says 'C'est le boutte!' about your cooking. What do they mean?",["It's terrible","It's just okay","It's great/awesome!","It needs salt"],2,"C'est le boutte! = It's awesome / It's the best! A classic Quebec informal expression. You'll also hear 'C'est l'boutte', 'trop l'boutte'. Use it yourself and Quebecers will love it — it shows you're embracing Quebec culture!",1),
     {type:"match",prompt:"Match the Quebec French expression to its meaning",pairs:[["le char","the car"],["magasiner","to go shopping"],["avoir de la misère","to have difficulty"],["tantôt","shortly / a little while ago"],["la tuque","the winter hat"]],explain:"These 5 expressions are uniquely Quebec! Using them (or at least understanding them) shows cultural integration. Quebec French is a living language with its own identity — embrace it!",diff:1},
     {type:"fill",before:"J'ai",blank:"___",after:"comprendre les instructions. (I had difficulty understanding the instructions.)",options:["de la misère à","du mal avec","problème pour","difficulté"],correct:0,explain:"J'ai de la misère à = I have difficulty (Quebec expression). In France French: j'ai du mal à. Both mean the same thing but de la misère à is specifically Quebec. Very common expression you'll hear every day!",diff:2},
     mcq("In Quebec, 'Allô!' is used as:",["Only when answering the phone","A greeting like Bonjour, used when meeting people","Only to say goodbye","A formal greeting"],1,"Allô! in Quebec is used as a friendly greeting — like 'Hi!' — not just on the phone. You'll hear Allô! when friends meet, when someone enters a room, or even in stores. Very Quebec, very warm!",2),
     {type:"scene",story:"Sara is at a dépanneur in Montreal. The cashier says 'Ça va-tu? T'as trouvé toute?' (How are you? Did you find everything?)",prompt:"What is the cashier asking? (Note: 'tu' added after verb is Quebec speech pattern)",options:["Are you okay? Did you find everything?","Do you want a bag? Is that all?","How much did you spend? Are you a regular?","Do you have a loyalty card? Is this everything?"],correct:0,explain:"'Ça va-tu?' = the Quebec way of making a yes/no question by adding '-tu' after the verb (Ça va? + tu). 'T'as trouvé toute?' = Did you find everything? (toute = tout in Quebec informal). This is authentic Montreal cashier language!",diff:3},
     {type:"order",prompt:"Say it Quebec style: I'm going shopping at the mall",words:["Je","vais","magasiner","au","centre","commercial"],answer:["Je","vais","magasiner","au","centre","commercial"],explain:"Je vais magasiner au centre commercial — using magasiner (Quebec) instead of faire du shopping (France). This small difference signals you know Quebec French! Centre commercial = mall. Magasiner is one of the most used Quebec verbs.",diff:1},
     wr("Write a sentence using a Quebec French expression you learned today",["char","dépanneur","magasiner","boutte","misère","tuque","tantôt"],"Using Quebec expressions shows cultural integration! Quebecers appreciate when immigrants embrace their unique language. It's not about being fake — it's about belonging to your new home.",2)]),

  mkL("a2-13","The Conditionnel — Polite French",25,"writing",
    "Want to sound instantly more polite and professional in French? Use the conditionnel! This tense transforms 'I want' into 'I would like', 'Can you?' into 'Could you?', 'I need' into 'I would need'. In Quebec workplaces, healthcare, and customer service, conditionnel is the marker of a professional. Today you master this essential tense.",
    ["Je voudrais = I would like (vouloir)","Je pourrais = I could (pouvoir)","Je devrais = I should (devoir)","Il faudrait = It would be necessary","Ce serait = It would be","Pourriez-vous? = Could you? (very polite request)","J'aimerais = I would like (aimer)","On devrait = We should","Ce serait bien si = It would be nice if","À votre place, je = In your place, I would"],
    [mcq("Which sounds more polite and professional in Quebec?",["Je veux un café","Je voudrais un café s'il vous plaît","Donnez-moi un café","Un café!"],1,"Je voudrais = I would like (conditionnel of vouloir). This single change from 'je veux' (I want) to 'je voudrais' (I would like) transforms a demand into a polite request. Used constantly in restaurants, stores, and offices in Quebec!",1),
     mcq("How do you politely ask your coworker to help you?",["Aide-moi!","Tu m'aides?","Pourriez-vous m'aider s'il vous plaît?","Je veux ton aide"],2,"Pourriez-vous m'aider? = Could you help me? (very polite). Pourriez-vous = could you (conditionnel of pouvoir + vous). This is the standard polite request in Quebec professional settings. Add s'il vous plaît for extra politeness!",1),
     {type:"match",prompt:"Match the infinitive to its conditionnel form",pairs:[["vouloir","voudrais"],["pouvoir","pourrait"],["devoir","devrait"],["être","serait"],["avoir","aurait"]],explain:"These 5 conditionnel forms are the most used in Quebec French. Voudrais (would like), pourrait (could), devrait (should), serait (would be), aurait (would have). Master these and your French becomes instantly more polished!",diff:2},
     {type:"fill",before:"",blank:"___",after:"vous me donner votre numéro de téléphone? (Could you give me your phone number?)",options:["Pourriez","Pouvez","Voulez","Devez"],correct:0,explain:"Pourriez-vous = could you (polite request using conditionnel). More polite than 'Pouvez-vous' (can you). In healthcare, banking, and formal situations in Quebec, Pourriez-vous is always the right choice!",diff:2},
     mcq("Your doctor says 'Vous devriez faire plus d'exercice'. What is she recommending?",["You must exercise every day","You should do more exercise","You cannot exercise","You have been exercising well"],1,"Vous devriez = you should (conditionnel of devoir). A recommendation, not a command. Devrait/devriez signals advice in French. Much softer than 'vous devez' (you must). Doctors, advisors, and friends use devriez to give gentle recommendations.",2),
     {type:"scene",story:"Amara calls a doctor's office in French. She says: 'Bonjour, je voudrais prendre un rendez-vous avec le Dr Tremblay. Ce serait possible pour la semaine prochaine?'",prompt:"What makes Amara's request sound professional and polite?",options:["She uses voudrais (would like) and serait (would be) — both conditionnel","She speaks very fast","She uses the informal tu form","She says merci at the end only"],correct:0,explain:"Voudrais (conditionnel of vouloir) + serait (conditionnel of être) = double politeness! This is exactly how to book a medical appointment in professional French. The secretary will immediately sense she's dealing with a respectful, considerate person.",diff:3},
     {type:"order",prompt:"Build the polite request: Could you please repeat that?",words:["Pourriez-vous","répéter","s'il","vous","plaît?"],answer:["Pourriez-vous","répéter","s'il","vous","plaît?"],explain:"Pourriez-vous répéter s'il vous plaît? — one of the most useful phrases in all of French! When you don't understand something in a meeting, at the doctor, or in a store, this polite request gets you what you need without embarrassment.",diff:2},
     wr("Write a polite request for something you need using the conditionnel",["je voudrais","pourriez-vous","j'aimerais","ce serait","il faudrait"],"Using conditionnel shows sophistication in French! Every time you use voudrais instead of veux, or pourriez-vous instead of pouvez-vous, you move from beginner to professional. This is the single most impactful grammar improvement you can make.",2)]),

  mkL("a2-14","Emergency Situations",20,"speaking",
    "Nobody wants to need emergency services in a foreign language — but being prepared could save your life or someone else's. In Quebec, emergencies are handled in French. 911 operators, firefighters, paramedics — they need information quickly and clearly. Today you learn exactly what to say in any emergency so you can stay calm and get help fast.",
    ["Au secours! = Help!","Appelez le 911! = Call 911!","Il y a un accident = There is an accident","Quelqu'un est blessé = Someone is injured","J'ai besoin d'une ambulance = I need an ambulance","Il y a un incendie = There is a fire","Je suis perdu(e) = I am lost","Où est l'hôpital le plus proche? = Where is the nearest hospital?","Je ne me sens pas bien = I don't feel well","Mon adresse est... = My address is..."],
    [mcq("You see someone collapse. What do you shout first?",["Au revoir!","Au secours! Appelez le 911!","Bonjour!","Excusez-moi"],1,"Au secours! = HELP! Then Appelez le 911! = Call 911! In Quebec, 911 is the emergency number for police, fire, and ambulance. Saying these two phrases loudly gets immediate attention from bystanders who will help!",1),
     mcq("The 911 operator asks 'Quelle est votre adresse?' What must you give?",["Your name","Your phone number","Your address","Your health card number"],2,"Quelle est votre adresse? = What is your address? This is always the first question after your emergency type. Learn your exact Quebec address in French — including the street number, street name, apartment number, and city. Practice saying it!",1),
     {type:"match",prompt:"Match the emergency phrase to its English meaning",pairs:[["Au secours!","Help!"],["Il y a un incendie","There is a fire"],["Quelqu'un est blessé","Someone is injured"],["J'ai besoin d'une ambulance","I need an ambulance"],["Je ne me sens pas bien","I don't feel well"]],explain:"In an emergency, you don't have time to think. These 5 phrases must be automatic. Practice them out loud right now — your brain stores them better that way. They could save a life someday.",diff:1},
     {type:"fill",before:"Il y a un accident sur",blank:"___",after:"principale. Quelqu'un est blessé!",options:["la rue","le magasin","l'école","le bureau"],correct:0,explain:"La rue = the street. Il y a un accident sur la rue principale = There is an accident on the main street. When calling 911, always describe the location as clearly as possible: la rue + street name + intersection if possible.",diff:2},
     mcq("You feel very sick but it's not life-threatening. You say to a nearby person:",["Au secours! Appelez le 911!","Je ne me sens pas bien. Pouvez-vous m'aider?","Il y a un incendie!","Je suis perdu"],1,"Je ne me sens pas bien = I don't feel well. + Pouvez-vous m'aider? = Can you help me? This is for non-emergency situations. Reserve 911 for true emergencies — police, fire, life-threatening situations. For less urgent help, ask a person nearby!",2),
     {type:"scene",story:"Sara smells smoke in her building at night. She calls 911. The operator says 'Service d'urgence, quelle est votre urgence?'",prompt:"What should Sara say?",options:["Il y a un incendie dans mon immeuble. Mon adresse est le 450 rue Sherbrooke, appartement 302, Montréal.","Bonjour, comment allez-vous?","Je ne sais pas","Au revoir"],correct:0,explain:"Il y a un incendie = there is a fire. Mon adresse est... = My address is... These two pieces of information — the emergency type and your exact address — are what 911 needs first. Clear, calm, and complete. Practice your address in French right now!",diff:2},
     {type:"order",prompt:"Call for help: There is an accident, someone is injured, call 911!",words:["Il","y","a","un","accident,","quelqu'un","est","blessé,","appelez","le","911!"],answer:["Il","y","a","un","accident,","quelqu'un","est","blessé,","appelez","le","911!"],explain:"Il y a un accident, quelqu'un est blessé, appelez le 911! — three short sentences that convey everything emergency responders need: the type, the victim, and the action. Practice this until it's automatic. In real emergencies, preparation saves lives.",diff:2},
     wr("Write your home address in French as you would say it to a 911 operator",["mon adresse","rue","appartement","Montréal","Québec","j'habite au"],"Mon adresse est le [number] [street name], appartement [X], [city]. Practice saying this clearly and quickly — in an emergency, you need to deliver this information immediately. Being able to say your address in French could save your life or someone else's.",2)]),

  mkL("a2-15","Futur Simple — Making Plans",20,"speaking",
    "Talk about the future in French! Whether you're discussing your Canadian citizenship goals, planning a vacation, or making next week's agenda, you need the futur simple. Today you learn to conjugate it, use it naturally, and talk confidently about your plans and dreams in Quebec. This tense opens up a whole new dimension of French conversation.",
    ["Futur simple: infinitif + endings (-ai, -as, -a, -ons, -ez, -ont)","je parlerai = I will speak","tu parleras = you will speak","il/elle parlera = he/she will speak","nous parlerons = we will speak","vous parlerez = you will speak","ils parleront = they will speak","Irregular: être→sera, avoir→aura, aller→ira, faire→fera, venir→viendra","Dans X ans = In X years","Quand je serai citoyen(ne) = When I am a citizen"],
    [mcq("How do you say 'I will work in Montreal next year'?",["Je travaille à Montréal l'année prochaine","Je travaillais à Montréal l'année prochaine","Je travaillerai à Montréal l'année prochaine","Je vais travailler Montréal"],2,"Je travaillerai = I will work (futur simple of travailler). L'année prochaine = next year. The futur simple ending for je is -rai. Travail-ler → travaille-rai. Drop the -r from -er verbs and add the endings!",1),
     mcq("'Nous serons canadiens dans deux ans.' What does this mean?",["We were Canadian two years ago","We are Canadian now","We will be Canadian in two years","We would be Canadian"],2,"Nous serons = we will be (futur of être — irregular: ser-). Dans deux ans = in two years. This is such a meaningful sentence for immigrants! Quand nous serons canadiens = when we will be Canadian — a beautiful goal to express in French.",1),
     {type:"match",prompt:"Match the infinitive to its futur simple form (je form)",pairs:[["parler","parlerai"],["avoir","aurai"],["être","serai"],["aller","irai"],["faire","ferai"]],explain:"These 5 futur forms include 4 irregular verbs you must memorize: avoir→aurai, être→serai, aller→irai, faire→ferai. The rest follow the regular pattern: infinitif + -ai for je. Learn these 5 and you can talk about almost anything in the future!",diff:2},
     {type:"fill",before:"Dans cinq ans, j'",blank:"___",after:"la citoyenneté canadienne.",options:["aurai","ai","avais","aurais"],correct:0,explain:"J'aurai = I will have (futur of avoir — irregular: aur-). Dans cinq ans, j'aurai la citoyenneté canadienne = In five years, I will have Canadian citizenship. A powerful sentence! The futur simple makes your goals concrete and real.",diff:2},
     mcq("'Quand tu viendras à Montréal, nous visiterons le Vieux-Port.' When will they visit the Old Port?",["They visited it last year","They are visiting it now","When you come to Montreal (in the future)","They never visited"],2,"Quand tu viendras (futur of venir) = when you come. Nous visiterons (futur of visiter) = we will visit. In French, after 'quand' referring to the future, you use futur simple in BOTH clauses — unlike English which uses present tense!",3),
     {type:"scene",story:"Ravi is talking about his 5-year plan: 'Dans cinq ans, j'aurai la citoyenneté canadienne. Je parlerai couramment le français. Ma famille viendra me rejoindre à Montréal et nous achèterons une maison.'",prompt:"All verbs are in futur simple. Which plan does Ravi express for his family?",options:["His family will come to join him in Montreal","His family is already in Montreal","His family came last year","His family doesn't want to come"],correct:0,explain:"Ma famille viendra (futur of venir) = my family will come. Me rejoindre = to join me. Nous achèterons (futur of acheter) = we will buy. Ravi's 5-year plan in perfect futur simple! This is exactly how to talk about goals and dreams in French.",diff:2},
     {type:"order",prompt:"Build: I will speak French fluently in two years",words:["Je","parlerai","couramment","le","français","dans","deux","ans"],answer:["Je","parlerai","couramment","le","français","dans","deux","ans"],explain:"Je parlerai couramment le français dans deux ans — say this out loud! Couramment = fluently. This is your commitment in French. Write it down, put it on your wall. Dans deux ans, you will indeed speak couramment!",diff:2},
     wr("Write about one of your goals for life in Canada using futur simple",["je","dans","ans","quand je serai","j'aurai","je parlerai","nous"],"Expressing your Canadian goals in futur simple makes them real! Whether it's citizenship, a career goal, buying a house, or mastering French — say it in French and commit to it. Dans quelques années, tu regarderas en arrière avec fierté!",2)]),
  mkL("a2-16","Comparing Things — More, Less, As Much",22,"speaking",
    "Real Quebec moment: you're shopping with a friend. 'This jacket is more expensive than that one,' you say. 'But it's warmer too.' Comparisons fill our daily conversations — at stores, choosing apartments, comparing schools, restaurants, jobs. Today you master French comparatives so you can express opinions and preferences naturally.",
    ["plus + adjective + que = more...than (Plus grand que)","moins + adjective + que = less...than (Moins cher que)","aussi + adjective + que = as...as (Aussi froid que)","Plus de + noun + que = more [noun] than","Moins de + noun + que = less [noun] than","Irregular: bon → meilleur (better) | bien → mieux (better)","Mauvais → pire (worse)","plus que vs plus de — adj vs noun!"],
    [mcq("'Montréal est __ grande __ Toronto.' (Montreal is bigger than Toronto)",["plus / que","moins / de","aussi / que","plus / de"],0,"Plus / que! Pattern: plus + adjective + que. 'Plus grande que' (Montréal is feminine, so grande). Compare anything: plus chaud que, plus cher que, plus loin que.",2),
     mcq("'Cette voiture coûte __ que l'autre.' (This car costs LESS than the other)",["plus","moins","aussi","mieux"],1,"Moins! 'Moins... que' = less than. 'Cette voiture coûte moins que l'autre' = This car costs less. Useful when shopping smart in Quebec!",2),
     {type:"match",prompt:"Comparison patterns",pairs:[["plus...que","more...than"],["moins...que","less...than"],["aussi...que","as...as"],["meilleur","better (adj)"],["mieux","better (adv)"]],explain:"5 comparisons. Crucial: meilleur is for adjectives (a better car = une meilleure voiture), mieux is for adverbs (he sings better = il chante mieux). Common mix-up!",diff:3},
     {type:"fill",before:"Mon café est",blank:"___",after:"chaud que le tien. (less hot)",options:["plus","moins","aussi","mieux"],correct:1,explain:"Moins chaud que = less hot than. Useful at any restaurant or café when comparing temperatures, sizes, prices. Practice: 'C'est moins cher chez Loblaws que chez IGA' (It's cheaper at Loblaws than at IGA).",diff:2},
     mcq("'Ce restaurant est __ que l'autre.' (better)",["plus bon","mieux","meilleur","plus mieux"],2,"Meilleur! Bon (good) → meilleur (better). NOT 'plus bon' — that's a beginner mistake. Une meilleure pizza, un meilleur café. Use it confidently!",3),
     {type:"scene",story:"Sara compares two apartments: 'Le premier est plus grand mais le deuxième est moins cher et aussi proche du métro.'",prompt:"Which apartment is closer to the metro?",options:["The first","The second","Both equally","Neither"],correct:2,explain:"Both equally close! 'Aussi proche' = as close. Sara is saying the second is just as close to the metro as the first. Real-life apartment comparison in perfect French!",diff:3},
     wr("Write 'Montreal is colder than Toronto' (froid = cold)",["montréal est plus froid que toronto","montréal est plus froide que toronto","montreal est plus froid que toronto"],"Montréal est plus froid que Toronto! Montreal is masculine (le Montréal). True statement weather-wise — Montreal winters are LEGENDARY!",3)]),
  mkL("a2-17","Superlatives — The Best, The Worst",20,"speaking",
    "What's your FAVORITE thing in Canada? The BEST poutine in town? The WORST winter day? Superlatives express extremes — and Quebec life is full of them. Today you learn the construction that makes one thing stand out from all others. Le plus, le moins, le meilleur, le pire — the highest expressions of opinion.",
    ["le plus + adjective = the most","la plus + adj (fem) = the most (fem)","les plus + adj (plural) = the most (plural)","le moins + adjective = the least","le meilleur = the best (irregular)","le pire = the worst","Quebec uses 'le meilleur' a LOT","Add 'de' for 'in': le plus grand DU pays (the biggest IN the country)"],
    [mcq("'C'est __ poutine de Montréal!' (the best)",["la plus bonne","la meilleure","le meilleur","la mieux"],1,"La meilleure poutine! Bon → meilleur(e). Poutine is feminine = la meilleure. 'La meilleure poutine de Montréal' = The best poutine in Montreal. (Try La Banquise — actually amazing!)",2),
     mcq("'Quel est __ jour de l'année?' (the longest day)",["le plus longue","le plus long","la plus longue","le mieux long"],1,"Le plus long! Jour is masculine + long is masc form. June 21 = le jour le plus long de l'année (the longest day of the year). Summer solstice in Quebec = LATE evenings!",2),
     {type:"match",prompt:"Superlatives",pairs:[["le plus","the most"],["le moins","the least"],["le meilleur","the best"],["le pire","the worst"],["le plus rapide","the fastest"]],explain:"5 superlatives in action. Note: 'le pire' is irregular (worse → worst). 'Le plus mauvais' also works but 'le pire' is more common.",diff:2},
     {type:"fill",before:"Mon hiver",blank:"___",after:"de l'histoire! (the worst)",options:["le pire","le mieux","le meilleur","plus mauvais"],correct:0,explain:"Le pire hiver! Quebec winters can be brutal — when one is especially bad, you'll hear locals say 'Le pire hiver!'. Useful expressive phrase.",diff:3},
     mcq("'Sara est l'employée la plus motivée DE l'équipe.' What does 'de l'équipe' mean?",["from the team","of the team","in the team","with the team"],2,"In the team! 'De' after a superlative = 'in'. The most motivated IN the team. Pattern: superlative + de + group. C'est le restaurant le plus cher DE Montréal.",3),
     wr("Write 'It's the best café in Montreal' (café masc)",["c'est le meilleur café de montréal","c'est le meilleur café à montréal","le meilleur café de montréal"],"C'est le meilleur café de Montréal! Use 'de' (not 'à') for 'in' after superlative. Defending your favorite cafe is essential Quebec social currency!",3)]),
  mkL("a2-18","Quebec Winter Survival",22,"reading",
    "January in Montreal. -25°C with windchill. Snow on every sidewalk. Ice on every step. Your car needs to be plugged in (yes, plugged in!). Quebec winter is unlike anywhere else in the world. Today you learn the vocabulary AND survival phrases that make YOU a Quebec winter expert. Without these, your first winter will be miserable.",
    ["la neige = snow | la glace = ice","la pelle = shovel | déneiger = to remove snow","les bottes d'hiver = winter boots","le manteau = coat","la tuque = wool hat (Quebec word!)","les mitaines = mittens","le froid mordant = bitter cold","la slush / la sloche = slush (mid-winter mess)","plug a car = brancher l'auto (engine block heater)","Faites attention à la glace! = Watch out for ice!"],
    [mcq("Quebec word for wool hat:",["le chapeau","la tuque","le bonnet","le manteau"],1,"La tuque! Pure Quebec — France calls it 'bonnet'. The TUQUE is Quebec's iconic winter accessory. Coloured, knitted, often with a pompom on top. EVERYONE wears one.",1),
     mcq("'Brancher l'auto' means:",["start the car","plug in the car","wash the car","park the car"],1,"Plug in the car! In Quebec winter (-20°C+), engine blocks need heating. Most parking spots have outlets ('prises') for this. Without it, your car may not start in extreme cold!",2),
     {type:"match",prompt:"Winter Quebec essentials",pairs:[["la tuque","wool hat"],["les mitaines","mittens"],["la pelle","shovel"],["déneiger","remove snow"],["la slush","slush"]],explain:"5 things you'll deal with EVERY winter day. Slush (la slush/sloche) is the wet snow mess on sidewalks. Buy GOOD winter boots — your feet will thank you!",diff:2},
     {type:"fill",before:"Il faut",blank:"___",after:"les marches avant de sortir. (shovel)",options:["déneiger","brancher","laver","fermer"],correct:0,explain:"Déneiger! In Quebec, you MUST shovel your stairs and entrance — it's the law in many cities, and required for safety. Quebec winters mean shoveling daily!",diff:2},
     mcq("Quebecer warns 'Il fait -30 avec le facteur vent!' What's important here?",["temperature is -30","windchill makes it feel -30","they ate at -30","-30 minutes"],1,"Windchill makes it feel -30! 'Facteur vent' = wind factor (windchill). Real temperature might be -20, but with wind it FEELS like -30. Critical to listen to weather reports!",3),
     wr("Write 'It's very cold today!' (using 'fait')",["il fait très froid aujourd'hui","il fait froid aujourd'hui","très froid aujourd'hui"],"Il fait très froid aujourd'hui! Bonus Quebec phrase: 'Il fait FRETTE aujourd'hui!' (Quebec dialect for 'it's freezing!'). 'Frette' is uniquely Québécois!",3)]),
  mkL("a2-19","At the Hospital — Emergency Situations",24,"speaking",
    "You hope you never need this lesson. But if you do — when you're in pain, scared, in the ER — knowing the right French could save you precious minutes. Today you learn emergency vocabulary, how to describe symptoms, ask for help, and navigate Quebec's hospital system. Print this lesson out. Keep it handy.",
    ["Au secours! = Help!","C'est une urgence = It's an emergency","Appelez le 911 = Call 911","une ambulance = an ambulance","Je saigne = I'm bleeding","J'ai mal partout = I hurt everywhere","Je n'arrive pas à respirer = I can't breathe","la salle d'urgence = emergency room","triage = triage (same word!)","Avez-vous votre carte d'assurance maladie? = Do you have your health card?"],
    [mcq("Most urgent phrase in an emergency:",["Bonjour","Au secours!","Excusez-moi","Pardon"],1,"Au secours! = Help! (urgent). Use it loudly when you NEED help fast. People will respond instantly. Memorize it now — hopefully you never need it.",1),
     mcq("'Appelez le 911' means:",["Call 911","I'm at 911","I called 911","911 is the number"],0,"Call 911! In Quebec emergencies, dial 911. Operators speak both English and French. Tell them your address (rue + numéro de maison + ville) and what's wrong.",1),
     {type:"match",prompt:"Emergency phrases",pairs:[["Au secours","Help"],["Une ambulance","An ambulance"],["Je saigne","I'm bleeding"],["la salle d'urgence","emergency room"],["la carte d'assurance maladie","health card"]],explain:"5 critical phrases. Tip: keep your RAMQ health card with you ALWAYS — required at any Quebec hospital. Without it, you'll pay full cost.",diff:2},
     {type:"fill",before:"Mon enfant a une",blank:"___",after:"de 39 degrés! (high fever)",options:["fièvre","douleur","blessure","tousse"],correct:0,explain:"Une fièvre = a fever. 39°C is high — go to ER (urgence) or pediatric clinic. Phrase: 'Mon enfant a une fièvre de 39 degrés' = My child has a fever of 39°C.",diff:2},
     mcq("Triage nurse asks: 'Sur une échelle de 1 à 10, votre douleur est de combien?'",["What time is it?","On scale 1-10, how much is your pain?","Where does it hurt?","Are you sure?"],1,"On scale 1-10, how much is your pain? Standard Quebec triage question. Answer with a number: 'Ma douleur est de 8' (My pain is 8). Higher = more urgent treatment.",3),
     wr("Write 'I have chest pain' (poitrine = chest)",["j'ai mal à la poitrine","j'ai mal a la poitrine","mal à la poitrine"],"J'ai mal à la poitrine! VERY important phrase — chest pain can mean heart attack. Say it FAST and CLEARLY at any ER. They'll prioritize you immediately!",3)]),
  mkL("a2-20","Banking Online & Bills",22,"reading",
    "In Quebec, MOST banking is online — and the website is in French by default. Setting up direct deposit, paying Hydro-Québec, Bell, Vidéotron — all in French. Today you learn the digital banking vocabulary so you can manage your money confidently online or by phone.",
    ["en ligne = online","mon compte en ligne = my online account","le mot de passe = password","l'identifiant = username","les paiements préautorisés = automatic payments","faire un virement = transfer money","la facture = bill / invoice","échéance = due date","les frais = fees","Hydro-Québec, Bell, Vidéotron = utilities companies"],
    [mcq("Online account =",["compte téléphone","mon compte en ligne","compte d'épargne","facture"],1,"Mon compte en ligne! Most Canadian banks have French websites. Login = 'connexion' or 'ouvrir une session'. Forgot password = 'mot de passe oublié'.",2),
     mcq("'Date d'échéance' on a bill means:",["payment date","amount","due date","reference"],2,"Due date! 'Échéance' = due date / deadline. Pay before this date to avoid 'frais de retard' (late fees). Hydro-Québec and Bell charge interest on late payments!",2),
     {type:"match",prompt:"Banking online",pairs:[["mot de passe","password"],["facture","bill"],["échéance","due date"],["virement","transfer"],["paiement","payment"]],explain:"5 essentials for digital banking. Quebec banks have great mobile apps — Desjardins, RBC, BMO. Set them up early in your immigration!",diff:2},
     {type:"fill",before:"J'ai besoin de faire un",blank:"___",after:"de 500$. (transfer)",options:["paiement","virement","retrait","dépôt"],correct:1,explain:"Un virement! Used for transferring money — between your accounts or to someone else's. 'Virement Interac' is Canada's e-transfer system. Free at most banks!",diff:2},
     mcq("Hydro-Québec bill arrives. The 'montant à payer' is:",["payment method","amount to pay","total balance","customer number"],1,"Amount to pay! 'Montant' = amount/sum. 'Montant à payer' or 'somme due' = what you owe. Don't ignore — Hydro will cut your power!",3),
     wr("Write 'I need to pay my electricity bill' (électricité)",["je dois payer ma facture d'électricité","payer ma facture d'électricité","ma facture d'électricité"],"Je dois payer ma facture d'électricité! In Quebec, 'Hydro-Québec' or 'Hydro' is the only electricity company — like AT&T but for power. You'll say this monthly!",3)]),
  mkL("a2-21","Renting in Montreal — The Hunt",22,"reading",
    "Apartment hunting season in Quebec is FAMOUSLY July 1st (moving day, called Saint-Jean-Baptiste). But rentals run year-round. Sites like Kijiji, Facebook Marketplace, Craigslist — all have French listings. Today you learn the vocabulary that helps you find AND understand what you're getting before signing.",
    ["3 1/2, 4 1/2, 5 1/2 = Quebec apartment sizes (rooms incl. bathroom)","chauffé, éclairé = heat & electricity included","semi-meublé = partly furnished","libre = available","occupé = occupied","prochaine disponibilité = next availability","caution / dépôt = security deposit (illegal in Quebec!)","À louer = For rent","quartier = neighborhood","loyer mensuel = monthly rent"],
    [mcq("In Quebec, '4 1/2' apartment means:",["4 rooms total","4.5 rooms","4 bedrooms","4 floors"],1,"4.5 rooms! Quebec counts rooms as '1 1/2' (studio with bath), '3 1/2' (1-bed), '4 1/2' (2-bed), '5 1/2' (3-bed). Bathroom = the 1/2. UNIQUELY QUEBEC!",2),
     mcq("'Chauffé et éclairé' on a listing means:",["heat & electricity included","there's a fireplace","it has a balcony","it has hardwood"],0,"Heat & electricity included! Often abbreviated 'C/E' or 'CHAUFFÉ ÉCLAIRÉ INCL'. Saves you $100-300/month on bills. Always look for this!",2),
     {type:"match",prompt:"Apartment listing terms",pairs:[["3 1/2","studio/1-bed"],["chauffé","heated"],["libre","available"],["meublé","furnished"],["quartier","neighborhood"]],explain:"5 essentials for understanding Quebec listings. Always note: chauffé éclairé = significant savings!",diff:2},
     {type:"fill",before:"L'appartement est libre le 1er",blank:"___",after:". (July)",options:["juin","juillet","août","septembre"],correct:1,explain:"Juillet = July. July 1st (Saint-Jean) is moving day in Quebec — most leases start/end then. Streets are CHAOS. Avoid moving on this day if possible!",diff:2},
     mcq("Landlord asks 'Avez-vous un garant?'",["Do you have furniture?","Do you have a guarantor?","Do you have ID?","Do you have pets?"],1,"Do you have a guarantor? 'Un garant' = someone who co-signs the lease (often required for newcomers without Quebec credit history). Common request — ask a friend or relative who has Quebec residency.",3),
     wr("Write 'I'm looking for a 4½ in Plateau' (Plateau is famous Montreal neighborhood)",["je cherche un 4 1/2 dans le plateau","je cherche un 4 et demi dans le plateau","cherche 4 1/2 plateau"],"Je cherche un 4 1/2 dans le Plateau! Plateau-Mont-Royal is a hip Montreal neighborhood. Use 'dans le' for neighborhoods. 'Je cherche' = I'm looking for!",3)]),
  mkL("a2-22","Reading Quebec News",20,"reading",
    "Reading Le Devoir, La Presse, Radio-Canada keeps you connected to Quebec society. News uses formal French — different from spoken language. Today you learn the news vocabulary that opens up Quebec/Canadian current events to you. Even understanding HEADLINES makes you part of the conversation.",
    ["les actualités / les nouvelles = the news","un article = an article","un journal = a newspaper","selon = according to","gouvernement = government","élection = election","économie = economy","santé = health","éducation = education","environnement = environment"],
    [mcq("'Selon le ministre' means:",["before the minister","according to the minister","after the minister","without the minister"],1,"According to the minister! 'Selon' = according to. Common in news: 'Selon le rapport' (according to the report). Marker of attribution.",2),
     mcq("'Les Québécois votent demain' means:",["Quebecers vote tomorrow","Quebec winners","Quebec wants","Quebec waters"],0,"Quebecers vote tomorrow! 'Voter' = to vote. 'Demain' = tomorrow. Important during election seasons. As an immigrant, learn the political landscape!",2),
     {type:"match",prompt:"News vocabulary",pairs:[["actualités","news"],["élection","election"],["économie","economy"],["selon","according to"],["gouvernement","government"]],explain:"5 essentials for following news. Quebec has its own provincial gov't (Premier — premier ministre) and federal gov't in Ottawa. Read both for full picture!",diff:2},
     {type:"fill",before:"Le ministre de la",blank:"___",after:"a annoncé... (the minister of HEALTH)",options:["santé","éducation","économie","justice"],correct:0,explain:"Santé = health. 'La ministre de la santé' = Minister of Health. Quebec's healthcare minister is in news constantly — RAMQ, hospitals, doctors all under their watch.",diff:2},
     mcq("Headline: 'Hausse des prix' means:",["price drop","price rise","new prices","fixed prices"],1,"Price rise/increase! 'Hausse' = rise/increase. Opposite: 'baisse' (decrease). Common in news about inflation, housing, gas prices. Learn this word!",3),
     wr("Write 'I read the news every day'",["je lis les nouvelles tous les jours","je lis les actualités tous les jours","tous les jours je lis les nouvelles"],"Je lis les nouvelles tous les jours! 'Lire' (to read), 'tous les jours' (every day). Habit-forming phrase — actually start reading some Quebec news. Le Devoir + La Presse are great!",3)]),
  mkL("a2-23","Watching Quebec TV & Movies",18,"listening",
    "Improving your French listening = watching Quebec content! Tou.tv, Radio-Canada, Crave have great Quebec series. Subtitles in French + English help. Today's vocabulary gets you discussing what you watched — entertainment is a powerful learning tool, AND a great social topic.",
    ["regarder un film = watch a movie","une série = a series","un épisode = an episode","les sous-titres = subtitles","l'acteur / l'actrice = actor / actress","ennuyeux = boring","intéressant = interesting","triste = sad","drôle = funny","Tu l'as vu? = Did you see it?"],
    [mcq("'Tu as vu cette série?' means:",["You like this series","Did you see this series?","You watch this series","You miss this series"],1,"Did you see this series? 'Tu as vu' = passé composé of voir (to see). Common conversation starter at work or with friends about TV/movies.",2),
     mcq("'Avec sous-titres' means:",["with sound","with subtitles","with surprises","with extras"],1,"With subtitles! 'Sous-titres' = subtitles. Watching Quebec content with French subtitles is PERFECT for learning. Slow accent + visual text = comprehension boost!",2),
     {type:"match",prompt:"Movie/TV vocabulary",pairs:[["un film","a movie"],["une série","a series"],["sous-titres","subtitles"],["drôle","funny"],["ennuyeux","boring"]],explain:"5 essentials for entertainment chat. Quebec series to start with: 'Les Beaux Malaises' (comedy), '19-2' (drama), 'District 31' (cop show). All have great French!",diff:2},
     {type:"fill",before:"Ce film était vraiment",blank:"___",after:"— j'ai pleuré! (sad)",options:["drôle","triste","ennuyeux","intéressant"],correct:1,explain:"Triste = sad. 'J'ai pleuré' = I cried. Useful reaction phrase to dramatic content. Quebecers love discussing reactions to shows — this gives you something to say!",diff:2},
     mcq("Quebec friend: 'C'est quoi le meilleur film québécois?' What did they ask?",["What's the worst Quebec movie?","What's the best Quebec movie?","What's a new Quebec movie?","Are there Quebec movies?"],1,"What's the best Quebec movie? Big question for any Quebec social gathering. Famous ones: 'C.R.A.Z.Y.' (2005), 'Mommy' (2014), 'Bon Cop Bad Cop' (2006). Watch one!",2),
     wr("Write 'I'm watching a Quebec series'",["je regarde une série québécoise","regarde une série québécoise","je regarde une serie quebecoise"],"Je regarde une série québécoise! Show off your Quebec assimilation — name a series you're watching. Conversation gold at any social event!",3)]),
  mkL("a2-24","Negation Mastery — Rien, Personne, Jamais",22,"reading",
    "English negation = 'I don't know nothing' (uses two negatives, sounds wrong). French negation = ALWAYS uses 'ne' + a negative word. Je ne sais rien (I know nothing). Je ne vois personne (I see nobody). Today you master French's complete negation system — no more 'just adding pas'.",
    ["ne... rien = nothing","ne... personne = nobody / no one","ne... jamais = never","ne... plus = no more / no longer","ne... aucun(e) = none / not any","ne... ni... ni = neither... nor","Pattern: ne + verb + negative word","Spoken French often drops 'ne': 'Je sais rien'"],
    [mcq("'Je n'ai rien' means:",["I have something","I have nothing","I have it","I have one"],1,"I have nothing! 'Ne... rien' wraps around 'ai'. Quick translation: rien = nothing. Common phrase: 'Je n'ai rien à dire' = I have nothing to say.",1),
     mcq("'Personne ne sait' means:",["Someone knows","Nobody knows","Everyone knows","I know"],1,"Nobody knows! When 'personne' is the SUBJECT, it goes BEFORE 'ne'. Pattern: 'Personne ne + verb'. Different from object position.",2),
     {type:"match",prompt:"Negation patterns",pairs:[["ne...rien","nothing"],["ne...personne","nobody"],["ne...jamais","never"],["ne...plus","no more"],["ne...aucun","none"]],explain:"5 negation pairs. ALL require 'ne' before the verb. In casual speech the 'ne' is often dropped, but written French keeps it!",diff:2},
     {type:"fill",before:"Je",blank:"___",after:"vais jamais à la salle de gym. (don't ever go)",options:["ne","pas","plus","rien"],correct:0,explain:"Je NE vais jamais! Pattern: ne + verb + jamais. 'Jamais' replaces 'pas' for emphasis. Stronger than just 'pas'. Common pattern in everyday Quebec French.",diff:2},
     mcq("'Il n'a plus de café' means:",["He has more coffee","He has no more coffee","He never has coffee","He has some coffee"],1,"He has no more coffee! 'Ne... plus' = no more / no longer. Common phrase at coffee shops: 'On n'a plus de café' (We're out of coffee). Useful daily phrase!",3),
     wr("Write 'I see nobody' (using 'ne...personne')",["je ne vois personne","je vois personne","ne vois personne"],"Je ne vois personne! Personne (nobody) goes after the verb (object position). Useful when describing empty places or feeling lonely. Practice all 5 negations daily!",3)]),
  mkL("a2-25","Asking for Help Confidently",18,"speaking",
    "Asking for help is HARD. We worry about looking stupid. But Quebec culture is REMARKABLY helpful — locals genuinely want immigrants to succeed. Today you learn 8 polite, confident ways to ask for help in any situation. After this you'll never feel stuck or alone in French Canada again.",
    ["Pouvez-vous m'aider? = Can you help me?","J'ai besoin d'aide = I need help","Je suis perdu(e) = I am lost","Je ne sais pas comment... = I don't know how to...","Pourriez-vous m'expliquer? = Could you explain to me?","C'est compliqué pour moi = It's complicated for me","Merci pour votre aide = Thank you for your help","Je vous remercie de votre patience = I thank you for your patience"],
    [mcq("Most polite way to ask for help:",["Help!","Pouvez-vous m'aider s'il vous plaît?","I help","Aide moi"],1,"Pouvez-vous m'aider s'il vous plaît? Polite, complete, gets help. In Quebec, 'pouvez-vous' is more polite than 'peux-tu' (informal). Always start with 'excusez-moi'!",2),
     mcq("'Je suis perdu' means:",["I am tired","I am lost","I am late","I am wrong"],1,"I am lost! Use this anywhere: in city streets, in stores looking for items, in a Quebec form you don't understand. People will gladly help when you say it!",1),
     {type:"match",prompt:"Help phrases",pairs:[["Pouvez-vous m'aider?","Can you help me?"],["Je suis perdu(e)","I am lost"],["J'ai besoin d'aide","I need help"],["Merci pour votre aide","Thank you for your help"],["C'est compliqué","It's complicated"]],explain:"5 confident help-asking phrases. Practice them — Quebec is one of the WARMEST places to ask for help. Most locals will go out of their way to help you!",diff:2},
     {type:"fill",before:"Excusez-moi, je",blank:"___",after:"pas où est l'entrée. (don't know)",options:["sait","sais","savez","savons"],correct:1,explain:"Je ne sais pas où est l'entrée! 'Sais' is je form of 'savoir' (to know facts). Pattern: 'Je ne sais pas où est...' = I don't know where ... is. Useful constantly!",diff:2},
     mcq("Acknowledging great help: 'You really saved me!'",["Tu m'as sauvé(e)!","Vous m'avez vraiment sauvé(e)!","Sauve moi!","Au secours!"],1,"Vous m'avez vraiment sauvé(e)! Formal you, past tense of sauver (to save), with 'vraiment' (really) for emphasis. Strong way to show appreciation!",3),
     wr("Write 'Could you explain to me please?'",["pourriez-vous m'expliquer s'il vous plaît","pourriez-vous m'expliquer","m'expliquer s'il vous plaît"],"Pourriez-vous m'expliquer s'il vous plaît? 'Pourriez-vous' (formal Could you) + 'm'expliquer' (explain to me) + 's'il vous plaît' (please). Triple polite! Use it confidently.",3)]),
  mkL("a2-26","Apologizing & Owning Mistakes",18,"speaking",
    "You forgot a meeting. You said something wrong. You bumped someone in the metro. Knowing how to apologize PROPERLY in French builds trust and respect. Quebec culture values genuine apologies — not over-the-top, but warm and clear. Today you learn the right phrases for any apology scenario.",
    ["Je suis désolé(e) = I'm sorry","Je m'excuse = I apologize","Pardon = Sorry / Excuse me (light)","Je vous prie de m'excuser = I beg your pardon (formal)","C'était une erreur = It was a mistake","Ce n'était pas mon intention = That wasn't my intention","Je ne le ferai plus = I won't do it again","Pouvez-vous me pardonner? = Can you forgive me?"],
    [mcq("Light, casual 'sorry' (bumping someone):",["Pardon","Je suis désolé","Je vous prie","Excuse moi"],0,"Pardon! Quick, light, automatic. Like saying 'oops sorry' in English. Use it when you bump someone, sneeze, interrupt briefly. Quick and warm.",1),
     mcq("'Je suis vraiment désolé(e)' adds:",["formality","really/truly","politeness","goodbye"],1,"Really/truly! 'Vraiment' = really. Adds emphasis to your apology. Use when the mistake was significant and you want to show you mean it.",2),
     {type:"match",prompt:"Apology phrases",pairs:[["Pardon","Light apology"],["Je suis désolé","I'm sorry"],["Je m'excuse","I apologize"],["Mes excuses","My apologies"],["Désolé du retard","Sorry for being late"]],explain:"5 apology phrases for different intensity. Pardon (light), Je suis désolé (medium), Je m'excuse (formal). Match to the situation!",diff:2},
     {type:"fill",before:"Désolé du",blank:"___",after:", la circulation était terrible. (delay)",options:["temps","retard","jour","stress"],correct:1,explain:"Désolé du retard! 'Retard' = delay/lateness. Standard Quebec apology when arriving late. Pair with explanation: 'la circulation était terrible' (traffic was terrible)!",diff:2},
     mcq("Formal apology in business email:",["Désolé!","Je vous prie de m'excuser pour ce retard","Pardon","Sorry"],1,"Je vous prie de m'excuser pour ce retard! Used in professional contexts. Translates as 'I beg your pardon for this delay'. Sounds elegant in French!",3),
     wr("Write a sincere apology: 'I'm really sorry, it won't happen again'",["je suis vraiment désolé, ça ne se reproduira plus","je suis vraiment désolée, ça ne se reproduira plus","je suis désolé, je ne le ferai plus"],"Je suis vraiment désolé(e), ça ne se reproduira plus! Combines apology + commitment. 'Se reproduire' = to happen again. Strong, professional apology.",3)]),
  mkL("a2-27","Describing People — Looks & Personality",20,"speaking",
    "Describing people is essential — telling a friend about a date, identifying someone in a story, recommending someone for a job. Today you learn descriptive vocabulary so you can paint a clear picture of anyone in French. Master this and you'll discuss people naturally with Quebec friends and colleagues.",
    ["grand(e) = tall | petit(e) = short","mince = slim | fort(e) = strong","les yeux bleus/verts/marron = blue/green/brown eyes","les cheveux blonds/bruns/noirs = blond/brown/black hair","sympa(thique) = friendly","sérieux/sérieuse = serious","drôle = funny","timide = shy","gentil/gentille = kind","intelligent(e) = smart"],
    [mcq("'Elle est mince' means:",["She is friendly","She is slim","She is busy","She is wise"],1,"Slim! 'Mince' = slim/thin. Common positive description. Note: 'maigre' (skinny) can sound negative. 'Mince' is neutral and pleasant.",1),
     mcq("'Mon ami est sympa' means:",["My friend is funny","My friend is friendly","My friend is famous","My friend is fine"],1,"Friendly! 'Sympa' (short for sympathique) = nice/friendly. The Quebec word for someone you like. 'Il est super sympa!' = He's really nice!",2),
     {type:"match",prompt:"Personality words",pairs:[["sympa","friendly"],["timide","shy"],["sérieux","serious"],["drôle","funny"],["gentil","kind"]],explain:"5 personality essentials. Combine: 'Elle est gentille et drôle' (She's kind and funny). Use these when describing colleagues, friends, family!",diff:2},
     {type:"fill",before:"Sara a les yeux",blank:"___",after:"et les cheveux longs. (blue)",options:["bleus","bleues","verts","brun"],correct:0,explain:"Bleus! 'Yeux' (eyes) is masculine plural, so 'bleus' (masc plural). 'Yeux verts' (green eyes), 'yeux noisette' (hazel eyes). Useful for identifying people!",diff:2},
     mcq("Polite way to describe an older person:",["Il est vieux","Il est âgé","Il est ancien","Il est old"],1,"Il est âgé. 'Âgé' (literally 'aged') is more polite than 'vieux' (old). Quebec respects elders — use 'âgé' for kindness. 'Une personne âgée' = an elderly person.",2),
     wr("Describe yourself: 'I am tall and friendly'",["je suis grand et sympa","je suis grande et sympa","je suis grande et sympathique"],"Je suis grand(e) et sympa! Add -e for female. Practice describing yourself — comes up at every job interview, dating site, social intro!",3)]),
  mkL("a2-28","Quebec Holidays & Traditions",18,"reading",
    "Saint-Jean-Baptiste (June 24), the Fête du Travail, the Réveillon de Noël, Mardi Gras... Quebec has unique celebrations you'll experience as an immigrant. Today you learn the holidays AND the cultural context. Knowing them lets you participate fully in your new home's seasonal rhythm.",
    ["Saint-Jean-Baptiste = Quebec's national holiday (June 24)","Jour du Canada = Canada Day (July 1)","Action de grâce = Thanksgiving (October)","Halloween = Halloween","Noël = Christmas","Réveillon de Noël = Christmas Eve dinner","Saint-Sylvestre = New Year's Eve","Pâques = Easter","Fête des Mères = Mother's Day","La Saint-Patrick = St. Patrick's Day"],
    [mcq("Quebec's biggest national holiday is:",["July 1","June 24","July 14","December 25"],1,"June 24 — Saint-Jean-Baptiste! Quebec's national holiday. Massive parties, fleur-de-lys flags everywhere, music, fireworks. As big as Canada Day for Quebecers!",1),
     mcq("'Le Réveillon de Noël' is:",["Christmas morning","Christmas Eve dinner","New Year's Eve","Boxing Day"],1,"Christmas Eve dinner! Late-night feast on Dec 24, often after midnight mass. Tourtière (meat pie), bûche de Noël (Yule log cake) are traditional. Family gathering!",2),
     {type:"match",prompt:"Holidays",pairs:[["Saint-Jean-Baptiste","June 24"],["Jour du Canada","July 1"],["Action de grâce","Thanksgiving"],["Réveillon","Eve dinner"],["Pâques","Easter"]],explain:"5 Quebec holidays you'll experience. Tip: Most Quebec stores close on Saint-Jean-Baptiste — plan errands accordingly!",diff:2},
     {type:"fill",before:"On va manger de la tourtière au",blank:"___",after:"de Noël! (Christmas Eve dinner)",options:["jour","réveillon","matin","soir"],correct:1,explain:"Au Réveillon de Noël! Tourtière (meat pie) is THE Quebec Christmas Eve dish. If invited to a Quebec Christmas, expect lots of food and lots of family!",diff:3},
     mcq("Common Halloween phrase in Quebec:",["Trick or treat!","Bonne fête!","Joyeuse fête de l'Halloween!","Bonbon!"],2,"Joyeuse fête de l'Halloween! Quebec celebrates Halloween big — costumes, candy ('bonbons'), decorated houses. Kids say 'Bonbon s'il vous plaît!' instead of 'trick or treat'.",2),
     wr("Write 'Happy Saint-Jean!' in French",["bonne saint-jean","bonne fête de la saint-jean","joyeuse saint-jean"],"Bonne Saint-Jean! Or 'Joyeuse Saint-Jean!'. The standard Quebec greeting on June 24. Say it warmly — it's a big day for Quebec identity and culture!",3)]),
  mkL("a2-29","Cooking & Food in French",20,"reading",
    "Quebec cuisine is unique and delicious — poutine, tourtière, sugar pie. Recipes online are often in French. Cooking shows on Radio-Canada are in French. Today you learn cooking vocabulary so you can navigate Quebec recipes AND impress at dinner parties when you bring 'un dessert maison' (a homemade dessert).",
    ["la cuisine = kitchen / cuisine","une recette = a recipe","cuire = to cook","préparer = to prepare","ajouter = to add","mélanger = to mix","cuire au four = bake","faire bouillir = to boil","une tasse = a cup (measurement)","une cuillère = a spoon"],
    [mcq("'Préchauffer le four' means:",["Open the oven","Preheat the oven","Clean the oven","Buy an oven"],1,"Preheat the oven! 'Préchauffer' = to preheat. 'Le four' = oven. Standard recipe instruction: 'Préchauffer le four à 180°C'. Notice Celsius — Canada uses metric!",2),
     mcq("'Une cuillère à soupe' is:",["a tablespoon","a teaspoon","a cup","a bowl"],0,"A tablespoon! 'Cuillère à soupe' (soup spoon = tablespoon, ~15ml). 'Cuillère à thé' = teaspoon (~5ml). Memorize for following recipes accurately!",2),
     {type:"match",prompt:"Cooking verbs",pairs:[["cuire","to cook"],["mélanger","to mix"],["ajouter","to add"],["bouillir","to boil"],["servir","to serve"]],explain:"5 essential cooking verbs. Imperative mode used in recipes: Mélangez, Ajoutez, Cuisez. Standard French recipe format!",diff:2},
     {type:"fill",before:"Ajoutez 2 tasses de farine et",blank:"___",after:"bien. (mix)",options:["servez","mélangez","cuisez","bouillez"],correct:1,explain:"Mélangez! Imperative form (vous form, used in instructions). Recipes always use 'vous' even though it's neutral. Common combination: 'Ajoutez puis mélangez bien'.",diff:2},
     mcq("'Cuire à feu doux' means:",["Cook on high heat","Cook on low heat","Cook in oven","Cook fast"],1,"Cook on low heat! 'Feu doux' = soft/low fire. 'Feu vif' = high heat. 'Feu moyen' = medium. Important nuance for following Quebec recipes correctly!",3),
     wr("Write 'Add salt and pepper' in French",["ajoutez le sel et le poivre","ajouter le sel et le poivre","ajoutez sel et poivre"],"Ajoutez le sel et le poivre! Imperative (vous form for recipes). 'Sel' (salt) and 'poivre' (pepper) — staples of any kitchen. Now you can cook in French!",3)]),
  mkL("a2-30","Daily Routine in French",20,"speaking",
    "Telling someone your daily routine is one of the first 'real conversation' things you'll do in French. Wake up, breakfast, work, dinner, sleep. Today you master daily-routine vocabulary using REFLEXIVE VERBS — verbs where you do something to yourself (wake yourself up, dress yourself). Critical concept!",
    ["se réveiller = to wake up","se lever = to get up","se laver = to wash (oneself)","s'habiller = to get dressed","prendre le petit-déjeuner = have breakfast","aller au travail = go to work","déjeuner = lunch (Quebec) / breakfast (France)","dîner = dinner","se coucher = to go to bed","s'endormir = to fall asleep"],
    [mcq("'Je me lève à 7 heures' means:",["I get up at 7","I leave at 7","I'm tired at 7","I sleep at 7"],0,"I get up at 7! 'Se lever' = to get oneself up. 'Je me lève' (I get myself up). Reflexive verbs use ME, TE, SE before the verb. Tu te lèves, il se lève, etc.",2),
     mcq("'Quebec' word for lunch (vs France):",["déjeuner","dîner","souper","goûter"],1,"Dîner! In Quebec: déjeuner = breakfast, dîner = lunch, souper = dinner. In France: déjeuner = lunch, dîner = dinner. Easy mix-up — pay attention to context!",2),
     {type:"match",prompt:"Reflexive routine verbs",pairs:[["se réveiller","wake up"],["se lever","get up"],["se laver","wash up"],["s'habiller","get dressed"],["se coucher","go to bed"]],explain:"5 essential reflexive verbs. Pattern: subject + reflexive pronoun (me/te/se) + verb. 'Je me réveille', 'tu te réveilles', 'il se réveille'. Master this!",diff:3},
     {type:"fill",before:"Je",blank:"___",after:"lève à 6h30 chaque matin. (myself)",options:["me","te","se","nous"],correct:0,explain:"Je ME lève. Reflexive pronoun for 'je' is 'me' — placed BEFORE the verb. 'Je me lève' (I get myself up). Practice with all reflexive verbs!",diff:2},
     mcq("Sara: 'Le matin, je me lave les dents.' What is she doing?",["Washing her hair","Brushing her teeth","Washing her hands","Sleeping"],1,"Brushing her teeth! 'Se laver les dents' = literally 'to wash oneself the teeth' — actually means brushing teeth. Quebec idiom! In France: 'se brosser les dents'.",3),
     wr("Write your morning: 'I get up at 7am'",["je me lève à 7 heures","je me leve à 7h","je me lève a 7 heures"],"Je me lève à 7 heures! Reflexive 'me' before lève. Add: 'Je me réveille à 7 heures et je me lève à 7h05.' (I wake up at 7 and get up at 7:05). Real morning routine!",3)]),
  mkL("a2-31","Reflexive Verbs Deep Dive",22,"reading",
    "Reflexive verbs in French are POWERFUL — and confusing for beginners. Se laver (wash oneself), s'habiller (dress oneself), s'amuser (enjoy oneself). They use special pronouns and have unique past tense rules. Today you go DEEP on reflexives so they become natural.",
    ["Reflexive = action on YOURSELF","Pronouns: me, te, se, nous, vous, se","Pattern: subject + reflexive + verb","Past: ÊTRE auxiliary + agreement","Je me suis lavé(e) = I washed (myself)","Negative: Je ne me lave pas","Imperative: Lave-toi! (informal) / Lavez-vous!","Some verbs are ONLY reflexive: s'évanouir (to faint)","Some are reflexive AND non-reflexive (laver = wash something else)"],
    [mcq("Past of 'je me lève' (I got up):",["J'ai me levé","Je me suis levé","Je suis me levé","Je m'ai levé"],1,"Je me suis levé(e)! Pattern: subject + reflexive + ÊTRE + past participle (with agreement). Reflexives ALWAYS use être, never avoir. Add -e for feminine!",3),
     mcq("Negation: 'I don't get dressed':",["Je m'habille pas","Je ne m'habille pas","Je ne pas m'habille","Je m'pas habille"],1,"Je ne m'habille pas! Negation wraps around the verb: ne + reflexive + verb + pas. The reflexive pronoun stays close to the verb.",3),
     {type:"match",prompt:"Reflexive verb patterns",pairs:[["se laver","wash oneself"],["s'amuser","enjoy oneself"],["se rappeler","remember"],["se dépêcher","hurry up"],["se reposer","rest"]],explain:"5 common reflexives. Note: 'rappeler' alone (without 'se') means 'to remind/call back'. With 'se' = remember. Reflexive changes meaning subtly!",diff:3},
     {type:"fill",before:"Hier soir, je",blank:"___",after:"couché tard. (got into bed)",options:["me","m'ai","ai","me suis"],correct:3,explain:"Je me suis couché(e)! Past tense reflexive: subject + me + suis + past participle. Add -e if female. 'Couché' from 'se coucher' (to go to bed).",diff:3},
     mcq("'Tais-toi!' is the imperative of:",["se taire (be quiet)","se laver","se lever","se couvrir"],0,"Se taire (to be quiet)! Imperative: 'Tais-toi!' = Be quiet! (informal). Formal: 'Taisez-vous!'. Reflexive imperatives use -toi, -nous, -vous AFTER the verb (with hyphen).",3),
     wr("Write 'I had fun yesterday' (using s'amuser)",["je me suis amusé hier","je me suis amusée hier","hier je me suis amusé"],"Je me suis amusé(e) hier! Reflexive past with être + agreement. Common phrase to share weekend stories. 'On s'est amusés' (we had fun) = great Quebec social phrase!",3)]),
  mkL("a2-32","Imparfait — The Other Past",22,"reading",
    "Passé composé tells what happened (single events). Imparfait describes how things WERE (continuing states, descriptions, habits). 'When I was young, I lived in Mumbai.' (J'étais jeune, J'habitais à Mumbai.) Today you master imparfait — essential for telling stories about your past life.",
    ["Imparfait = was/were doing / used to do","Forms: -ais, -ais, -ait, -ions, -iez, -aient","From nous form of present + endings","Je parlais = I was speaking / I used to speak","Tu mangeais = You were eating","Il/Elle/On était = He/she/we was/were","Use for: descriptions, habits, ongoing past actions","Often paired with passé composé in stories"],
    [mcq("'Quand j'étais jeune' means:",["When I was young","When I am young","When I will be young","When I'm young"],0,"When I was young! 'Étais' = was (imparfait of être). Used for past states/conditions. Common opening for memories: 'Quand j'étais jeune, j'habitais...'.",1),
     mcq("Pattern: nous form (parlons) + ais →",["parlais","parlons","parle","parler"],0,"Parlais! Drop -ons from nous form (parlons → parl-) + add ending (-ais for je). Same pattern for ALL verbs (except être). Predictable!",2),
     {type:"match",prompt:"Imparfait endings",pairs:[["je","-ais"],["tu","-ais"],["il/elle","-ait"],["nous","-ions"],["ils/elles","-aient"]],explain:"6 imparfait endings. Note: -ais and -ait sound IDENTICAL (silent endings). Listen carefully or spell carefully when conjugating!",diff:3},
     {type:"fill",before:"Nous",blank:"___",after:"souvent à la plage en été. (used to go)",options:["allons","allions","allais","sommes allés"],correct:1,explain:"Nous allions! Imparfait of aller for nous = allions. 'Souvent en été' (often in summer) signals habit/repeated action — perfect for imparfait. Used to go = allions.",diff:3},
     mcq("Choose imparfait or passé composé: 'It was raining when I arrived'",["Il pleuvait quand je suis arrivé","Il a plu quand j'arrivais","Il pleuvait quand j'arrivais","Il a plu quand je suis arrivé"],0,"Il pleuvait (imparfait — ongoing) quand je suis arrivé (passé composé — single event)! Imparfait sets the scene; passé composé interrupts it. Classic combo!",3),
     wr("Write 'When I was 5, I lived in Mumbai' (use imparfait)",["quand j'avais 5 ans, j'habitais à mumbai","quand j'avais 5 ans, j'habitais a mumbai","j'avais 5 ans, j'habitais à mumbai"],"Quand j'avais 5 ans, j'habitais à Mumbai! Both verbs in imparfait — describing past state and continuous action. Note: 'j'avais' (had — for age) and 'j'habitais' (was living).",3)]),
  mkL("a2-33","Subjunctive Introduction",22,"writing",
    "The subjunctive — the tense that scares French learners. But it's actually USEFUL: expressing wishes, doubts, emotions, necessity. 'Je veux que tu viennes' (I want you to come). 'Il faut que je parte' (I have to leave). Today you get the basics. You'll know what it is and use the most common forms.",
    ["Subjunctive = expresses wish, doubt, emotion, necessity","Triggered by: 'que' + emotion/wish","Il faut que = It's necessary that","Je veux que = I want that","Avant que = before that","Forms: usually nous form + subjunctive endings","Common: que je sois (be), que j'aie (have), que je puisse (can)","Don't panic — start with most-common verbs!"],
    [mcq("'Il faut que je parte' means:",["I left","I'm leaving","I have to leave","I want to leave"],2,"I have to leave! 'Il faut que' triggers subjunctive. 'Parte' = subjunctive of partir (to leave). Common phrase in Quebec workplace at end of meetings.",2),
     mcq("'Je veux que tu __ heureux.' (be happy)",["es","sois","est","sera"],1,"Sois! Subjunctive of être for tu = sois. 'Je veux que' wants subjunctive. 'Je veux que tu sois heureux' = I want you to be happy. Sweet phrase!",3),
     {type:"match",prompt:"Subjunctive triggers",pairs:[["Il faut que","necessity"],["Je veux que","wish"],["Bien que","although"],["Avant que","before"],["Pour que","so that"]],explain:"5 common subjunctive triggers. After 'que' — verb usually goes to subjunctive. Memorize triggers; the form follows.",diff:3},
     {type:"fill",before:"Je veux que tu",blank:"___",after:"à temps. (arrive — subj of arriver)",options:["arrives","arrivais","arriveras","sois arrivé"],correct:0,explain:"Arrives! Subjunctive of arriver for tu = arrives (same as present, lucky!). 'Je veux que tu arrives à temps' = I want you to arrive on time.",diff:3},
     mcq("'Bien qu'il soit fatigué, il travaille.' (Despite him being tired)",["bien que + indicative","bien que + subjunctive","bien que + infinitive","no rule"],1,"Bien que + subjunctive! 'Soit' (subjunctive of être) follows 'bien que' (although). One of the most common subjunctive triggers — note it!",3),
     wr("Write 'I want you (informal) to be happy' using subjunctive",["je veux que tu sois heureux","je veux que tu sois heureuse","je veux que tu sois content"],"Je veux que tu sois heureux/heureuse! Beautiful sentence — wish for happiness. Subjunctive 'sois' (être) + adjective. Express your hopes for friends and loved ones!",3)]),
  mkL("a2-34","Combining Pronouns — When You Use 2",18,"speaking",
    "'I gave it to him.' Two pronouns: 'it' and 'him'. French combines them: 'Je le lui ai donné.' Order matters! Today you learn the rules for stacking pronouns — a sign of fluent French. Master this and your speech becomes seamless.",
    ["Order: me/te/se/nous/vous → le/la/les → lui/leur → y → en","Je le lui ai donné = I gave it to him","Donne-le-moi = Give it to me (imperative)","Je vous y emmène = I'm taking you there","Il y en a = There is/are some","En lui parlant = By talking to him","Y vs en order: y before en","Practice common patterns first"],
    [mcq("'I gave the book to Sara' → using pronouns:",["Je lui le ai donné","Je le lui ai donné","Je l'ai donné lui","Je lui ai le donné"],1,"Je le lui ai donné! Order: le (it/the book) BEFORE lui (to her). Memorize order: le/la/les BEFORE lui/leur. Stick to this order!",3),
     mcq("'Il y en a beaucoup' means:",["He has a lot","There are a lot","It is a lot","I have a lot"],1,"There are a lot! 'Il y en a' = there is/are some/any. Used to indicate availability. 'Il y en a beaucoup' = there are many. SUPER common Quebec phrase!",2),
     {type:"match",prompt:"Pronoun combinations",pairs:[["Je le lui donne","I give it to him/her"],["Il y en a","There are some"],["Donne-le-moi","Give it to me"],["Je vous y emmène","I take you there"],["Je m'en souviens","I remember it"]],explain:"5 common pronoun combos. The order is FIXED — memorize through repetition. Just say each phrase 10 times!",diff:3},
     {type:"fill",before:"Tu as une voiture? Oui, j'",blank:"___",after:"ai une. (I have one)",options:["la","y","en","l'"],correct:2,explain:"J'EN ai une! 'En' replaces 'une voiture' (de + thing). 'Une' specifies quantity (one). Common pattern in conversation: 'Tu en as?' 'Oui, j'en ai!'",diff:2},
     mcq("Imperative: 'Give it to him!' (le + lui):",["Le lui donne!","Donne-le-lui!","Donne lui le!","Donne le-lui!"],1,"Donne-le-lui! Imperative changes order: verb-FIRST, then le, then lui (with hyphens). Note: imperatives have unique order!",3),
     wr("Write 'I'm sending it to her' (envoyer + le + lui)",["je le lui envoie","je l'envoie à elle","je le lui envoie."],"Je le lui envoie! Pronouns BEFORE the verb in standard French. Le (it) BEFORE lui (to her). Practice this combination — once it clicks, you sound fluent!",3)]),
  mkL("a2-35","Y vs En Practice",18,"speaking",
    "Y replaces 'à + place/thing'. En replaces 'de + thing'. Sometimes both — 'Il y en a' (there are some). Today you SOLIDIFY the difference through practice. After this, Y and EN feel automatic in your speech.",
    ["Y = à + place/thing (J'y vais = I go there)","En = de + thing (J'en veux = I want some)","Y for: locations (Montréal), phrases with à","En for: quantities, partitive (du, de la, des), de + thing","Both before verb (except imperative)","Imperative: Vas-y! (go!) | Manges-en! (eat some!)","Negative: N'y va pas | N'en mange pas","Quebec uses both constantly!"],
    [mcq("'Tu vas au gym?' Reply with Y:",["Oui, je vais","Oui, j'y vais","Oui, j'en vais","Oui, je le vais"],1,"Oui, j'y vais! 'Y' replaces 'au gym' (à + place). Goes before vais. 'J'y vais' = I'm going (there). Quebec speech!",2),
     mcq("'Tu manges du pain?' Reply with EN:",["Oui, j'en mange","Oui, j'y mange","Oui, je le mange","Oui, j'ai mangé"],0,"Oui, j'en mange! 'En' replaces 'du pain' (de + thing, partitive). Common at meals. 'En' for partitive expressions. Master this!",2),
     {type:"match",prompt:"Y vs En",pairs:[["J'y vais","à un endroit"],["J'en mange","de la nourriture"],["J'y pense","à quelque chose"],["J'en veux","de cette chose"],["Vas-y!","Go (there)!"]],explain:"5 examples. Pattern: Y for à + thing/place. En for de + thing. Master through pattern recognition!",diff:3},
     {type:"fill",before:"Tu connais Montréal? Oui, j'",blank:"___",after:"vis depuis 2 ans.",options:["la","y","en","le"],correct:1,explain:"J'y vis! Y replaces 'à Montréal' (à + place). 'J'y vis depuis 2 ans' = I've lived there for 2 years. Natural way to talk about your time in Quebec.",diff:3},
     mcq("'Combien de cafés as-tu bus?' Reply 'three':",["J'ai bu trois","J'en ai bu trois","Trois j'ai bu","Bu trois"],1,"J'en ai bu trois! With quantities, EN is REQUIRED. Without 'en' it sounds incomplete. Memorize: any time you specify quantity (number + previously mentioned thing) = EN.",3),
     wr("Reply to 'Tu y vas demain?' (Are you going there tomorrow?) — say yes",["oui, j'y vais demain","oui j'y vais","j'y vais demain"],"Oui, j'y vais demain! Y refers back to the place mentioned. Saves repeating 'au [lieu]'. Quebecers use this constantly. Master Y to sound like a local!",3)]),
  mkL("a2-36","A2 Speaking — Real Conversations",22,"speaking",
    "You've completed 35 A2 lessons. Today's challenge: SUSTAINED conversation. Not just answering questions — but engaging back, sharing your story, asking questions in return. Today's lesson simulates real Quebec social interactions. Practice these and you'll handle ANY workplace or social conversation.",
    ["Comment vous trouvez le Québec? = What do you think of Quebec?","C'est différent de... = It's different from...","Ce qui me plaît, c'est... = What I like is...","Au début c'était dur, mais... = At first it was hard, but...","On s'habitue à tout = One gets used to everything","Je m'intègre petit à petit = I'm integrating little by little","Vous avez raison = You're right","C'est intéressant ce que vous dites = What you say is interesting","Je vois ce que vous voulez dire = I see what you mean","Tout à fait! = Exactly!"],
    [mcq("Polite agreement in Quebec:",["Yes!","Tout à fait!","D'accord","All of these"],3,"All of these! Each works in different contexts. 'Tout à fait!' = exactly/absolutely (warm agreement). 'D'accord' = OK/agreed. 'Oui' = yes. Mix and match!",2),
     mcq("'Ce qui me plaît au Québec, c'est la nature' means:",["I don't like nature","Nature doesn't please me","What I like in Quebec is nature","Nature is in Quebec"],2,"What I like in Quebec is nature! 'Ce qui me plaît' = what pleases me / what I like. Strong way to express positive opinions. Commonly used by integrating immigrants.",3),
     {type:"match",prompt:"Conversation phrases",pairs:[["Comment vous trouvez","What do you think"],["Au début","At first"],["On s'habitue","One gets used"],["Je m'intègre","I'm integrating"],["Tout à fait","Exactly"]],explain:"5 sustained-conversation phrases. Use them to keep dialogues flowing naturally. Quebecers love when immigrants speak this fluently!",diff:3},
     {type:"fill",before:"Au début c'était difficile, mais maintenant je",blank:"___",after:"intègre bien. (myself)",options:["m'","te","se","l'"],correct:0,explain:"Je m'intègre! Reflexive 'me' before vowel becomes m'. 'S'intégrer' = to integrate (oneself). Common conversation about immigrant experience. Be honest about the journey!",diff:3},
     mcq("Quebec local says: 'Vous parlez bien français!' Best response:",["Merci! J'apprends depuis 6 mois","Yes","Bonjour","Au revoir"],0,"Merci! J'apprends depuis 6 mois! Modest, accurate, conversational. They asked you a personal question — reciprocate with information. Builds rapport!",2),
     wr("Share your Quebec experience: 'I really like the people here' (les gens = the people)",["j'aime vraiment les gens ici","j'aime beaucoup les gens ici","les gens ici sont sympa"],"J'aime vraiment les gens ici! 'Vraiment' (really) shows genuine appreciation. Quebec PEOPLE are why Quebec works — saying this to a Quebecer is heartwarming!",3)]),
  mkL("a2-37","A2 Writing — Letters & Forms",22,"writing",
    "Quebec life means writing — emails to teachers, letters to landlords, complaints to companies, requests to govt. Today you learn FORMAL French writing patterns. Master these structures and you'll handle any official communication confidently. Critical skill for adult life in Quebec.",
    ["Madame, Monsieur = Dear Sir/Madam","Je vous écris pour... = I'm writing to...","En espérant une réponse rapide = Hoping for a quick reply","Je vous prie d'agréer mes salutations distinguées = Yours sincerely (formal close)","Dans l'attente de... = Awaiting...","Cordialement = Kind regards","En vous remerciant d'avance = Thanking you in advance","Veuillez trouver ci-joint = Please find attached","P.S. = same","Date format: 27 avril 2026 (day month year)"],
    [mcq("Most formal email opening (don't know recipient name):",["Salut!","Madame, Monsieur,","Cher ami","Bonjour"],1,"Madame, Monsieur,! Used when you don't know if recipient is male or female. Standard for first contact with companies, govt offices, officials. ALWAYS this format!",2),
     mcq("Formal closing line:",["Bye","Je vous prie d'agréer mes salutations distinguées","Salut","À +"],1,"Je vous prie d'agréer mes salutations distinguées! Long, formal, used in official letters. Translates to 'Please accept my distinguished greetings'. Sounds elegant!",3),
     {type:"match",prompt:"Letter components",pairs:[["Madame, Monsieur","greeting"],["Je vous écris pour","opening"],["Veuillez trouver ci-joint","attaching"],["Cordialement","semi-formal close"],["P.S.","postscript"]],explain:"5 letter essentials. Combine for any formal correspondence. Quebec values polite, structured writing — these phrases are your toolkit.",diff:2},
     {type:"fill",before:"En vous remerciant d'avance",blank:"___",after:"de votre attention. (and)",options:["et","ou","mais","donc"],correct:0,explain:"Et de votre attention! Common closing phrase: 'En vous remerciant d'avance et de votre attention'. Very polite — used in business correspondence.",diff:3},
     mcq("Date format on Quebec letters:",["April 27, 2026","27/04/2026","27 avril 2026","2026-04-27"],2,"27 avril 2026! Quebec format: day + month + year, all in French. NO commas. Sometimes 'le' is added: 'le 27 avril 2026'. Different from US format!",2),
     wr("Write a formal opening: 'I am writing to request information'",["je vous écris pour demander des informations","je vous écris pour demander des renseignements","je vous écris pour demander information"],"Je vous écris pour demander des renseignements/informations! 'Renseignements' is more formal than 'informations'. Use it in official requests. Polite, professional!",3)]),
  mkL("a2-38","A2 Listening — Radio & Podcasts",18,"listening",
    "Listening is the HARDEST skill — French speakers don't pause! Quebec radio (Radio-Canada, ICI Première) and podcasts give native-speed input. Today you learn vocabulary and strategies for understanding. After this lesson you'll catch more of every Quebec conversation around you.",
    ["la radio = radio","un podcast = a podcast","une émission = a show / program","l'animateur / l'animatrice = host","l'invité(e) = guest","Pouvez-vous parler plus lentement? = Can you speak more slowly?","Je n'ai pas saisi = I didn't catch","Pouvez-vous épeler? = Can you spell it?","l'accent = accent","les paroles = lyrics / words"],
    [mcq("'Je n'ai pas saisi' means:",["I disagree","I didn't catch","I don't know","I don't want"],1,"I didn't catch (it)! 'Saisir' = to grasp/catch. Useful when you missed a word in conversation: 'Je n'ai pas saisi votre nom' (I didn't catch your name). Polite way to ask for repetition!",2),
     mcq("Quebec radio host says 'Mon prochain invité est...' What did they say?",["My past guest","My next guest","My only guest","My weekly guest"],1,"My next guest! 'Prochain' = next. Common in interviews and shows. Listening tip: listen for transition words like 'prochain', 'maintenant', 'ensuite' — they signal what's coming.",2),
     {type:"match",prompt:"Listening vocab",pairs:[["la radio","radio"],["un podcast","podcast"],["l'invité","the guest"],["l'accent","accent"],["les paroles","lyrics"]],explain:"5 essentials. Recommended Quebec podcasts: 'Radio-Canada Première' (news), 'On va se le dire' (cultural), 'Coup de Cœur' (music). Start listening!",diff:2},
     {type:"fill",before:"L'animateur a un accent",blank:"___",after:"— c'est dur à comprendre. (strong)",options:["fort","faible","beau","léger"],correct:0,explain:"Un accent fort = strong accent. Different Quebec regions have different accents — Montreal vs Quebec City vs Saguenay. Listen to multiple sources!",diff:2},
     mcq("Strategy when listening to fast Quebec speech:",["Translate every word","Listen for keywords","Give up","Read instead"],1,"Listen for keywords! Don't try to understand every word — listen for verbs (action), nouns (topic), and connectors (et, mais, donc). Get the GIST first, details second.",3),
     wr("Write 'I'm listening to a French podcast'",["j'écoute un podcast en français","j'écoute un podcast français","j'ecoute un podcast"],"J'écoute un podcast en français! Best practice for daily improvement. Try 'On va se le dire' or 'Le balado de la francophonie'. Listen 15 min daily!",3)]),
  mkL("a2-39","A2 Reading — News & Articles",18,"reading",
    "Reading Le Devoir, La Presse, Radio-Canada articles improves vocabulary FAST. News uses formal French — clean, structured, with predictable vocabulary. Today you learn reading strategies and the most common news vocabulary so you can stay informed about Quebec and Canada.",
    ["un article = an article","un titre = a title / headline","l'introduction = introduction","le contenu = content","la conclusion = conclusion","selon = according to","par contre = however","en effet = indeed","par ailleurs = furthermore","en bref = in brief"],
    [mcq("'En effet' means:",["in effect","indeed","in fact","all of these"],3,"All of these! 'En effet' is a versatile connector — confirms what was just said. Used to add emphasis. Common in news and formal speech.",2),
     mcq("'Selon le ministre' is a:",["question","attribution (according to)","conclusion","example"],1,"Attribution (according to)! 'Selon X' = according to X. Critical news word — tells you WHO is making a claim. Always note: who is the source?",2),
     {type:"match",prompt:"News connectors",pairs:[["selon","according to"],["par contre","however"],["en effet","indeed"],["par ailleurs","furthermore"],["en bref","in brief"]],explain:"5 essential news connectors. They guide you through arguments. 'Par contre' (however) signals contrast — important point coming!",diff:2},
     {type:"fill",before:"L'inflation a augmenté.",blank:"___",after:", les salaires n'ont pas suivi. (However)",options:["Selon","Par contre","En effet","Par ailleurs"],correct:1,explain:"Par contre = However! Signals contrast/contradiction. Useful in essays and news analysis. 'L'inflation augmente, par contre les salaires stagnent' — perfect Quebec news sentence!",diff:3},
     mcq("Reading strategy for difficult articles:",["Translate every word","Read headline + intro + conclusion","Skip the article","Use Google translate"],1,"Read headline + intro + conclusion! Get the main idea first. Then reread for details. Most news follows: headline (key fact) + intro (context) + body (details) + conclusion. Master this skim strategy!",3),
     wr("Write 'I read the news every day in French'",["je lis les nouvelles tous les jours en français","je lis les actualités tous les jours en français","tous les jours je lis les nouvelles"],"Je lis les nouvelles tous les jours en français! Daily reading improves comprehension fast. Le Devoir or La Presse — both excellent. Build the habit!",3)]),
  mkL("a2-40","A2 Final Assessment — CLB 4 Ready",30,"mixed",
    "FÉLICITATIONS! You've completed 40 A2 lessons. From basic greetings to subjunctive, from grocery shopping to formal letters, from describing yourself to engaging in real Quebec conversations — you've covered it all. Today's final lesson tests EVERYTHING. Pass this and you're CLB 4 ready — qualified for Canadian citizenship language requirements!",
    ["All grammar tenses (present, passé composé, imparfait, futur, conditional)","All pronouns (le, la, lui, leur, y, en + reflexive)","Negation (ne...pas, ne...rien, ne...personne, ne...jamais)","Comparisons + superlatives","Quebec daily life vocabulary","Formal & informal speech","Asking and answering complex questions","Telling stories about your past, present, future","Quebec culture & traditions","CLB 4 = independent communication for daily Canadian life"],
    [mcq("Mixed tenses: 'When I was 18, I lived in India and now I live in Quebec'",["Quand j'ai eu 18 ans, j'ai habité en Inde et maintenant j'habite au Québec","Quand j'avais 18 ans, j'habitais en Inde et maintenant j'habite au Québec","Quand j'aurai 18 ans, j'habiterai en Inde et maintenant j'habite au Québec","Quand j'avais 18 ans, j'ai habité en Inde et maintenant j'habite au Québec"],1,"Quand j'avais 18 ans (imparfait — past state), j'habitais en Inde (imparfait — continuous past), et maintenant j'habite au Québec (present). Mix of tenses for storytelling — perfect French!",3),
     mcq("Most polite request: 'Could you please help me with this form?'",["Aide-moi!","Pouvez-vous m'aider avec ce formulaire s'il vous plaît?","Pourriez-vous m'aider avec ce formulaire s'il vous plaît?","Help me!"],2,"Pourriez-vous m'aider avec ce formulaire s'il vous plaît? Conditional 'pourriez' = most polite. Perfect for any govt office, professional setting, or formal interaction.",2),
     {type:"match",prompt:"Match the situation to the right phrase",pairs:[["Greeting a stranger formally","Bonjour Madame, Monsieur"],["Apologizing for being late","Désolé du retard"],["Asking for repetition","Pouvez-vous répéter?"],["Saying you don't understand","Je ne comprends pas"],["Closing a formal email","Cordialement"]],explain:"5 essential phrases for daily life. Master them all and you handle 90% of Quebec social/professional situations confidently!",diff:3},
     {type:"fill",before:"Si j'étais riche, je",blank:"___",after:"un voyage en France. (would do)",options:["fais","ferais","ferai","faisais"],correct:1,explain:"Ferais — conditional! 'Si + imparfait, conditionnel' for hypothetical situations. 'If I were rich, I would take a trip.' Sophisticated French structure — A2 mastery!",diff:3},
     mcq("'Je voudrais que tu sois heureux' means:",["I want you to be happy","I will be happy","You're happy","I should be happy"],0,"I want you to be happy! Subjunctive 'sois' (être) after 'que tu'. Beautiful sentence — express your hopes for friends. A2-level grammar in action!",3),
     {type:"scene",story:"Real-life test: At a Quebec networking event, your colleague introduces you to a director. You greet, share your story, ask about their work. Director says 'Je dirige une équipe de 50 personnes ici à Montréal.'",prompt:"Most natural follow-up:",options:["Wow!","C'est intéressant. Depuis combien de temps êtes-vous dans ce poste?","Bonjour","Au revoir"],correct:1,explain:"C'est intéressant. Depuis combien de temps êtes-vous dans ce poste? — Show interest, ask follow-up. 'Depuis combien de temps' = how long. Professional, warm, perfect Quebec networking!",diff:3},
     {type:"order",prompt:"Build a complete sentence: 'When I came to Quebec, I didn't speak French at all'",words:["Quand","je","suis","arrivé(e)","au","Québec,","je","ne","parlais","pas","du","tout","français"],answer:["Quand","je","suis","arrivé(e)","au","Québec,","je","ne","parlais","pas","du","tout","français"],explain:"Quand je suis arrivé(e) (passé composé — arrived, single event) au Québec, je ne parlais pas du tout français (imparfait — past state, didn't speak). 'Pas du tout' = not at all. EXCELLENT — A2 mastery achieved!",diff:3},
     wr("Final challenge: write 2 sentences about your Quebec life — past + present",["quand je suis arrivé","j'étais","maintenant","je parle","j'habite","j'aime"],"BRAVO! You've completed A2! Example: 'Quand je suis arrivé(e) au Québec en 2024, je parlais très peu français. Maintenant, je peux avoir des conversations entières en français et je m'intègre de plus en plus.' YOU ARE CLB 4 READY — qualified for Canadian citizenship language requirements! Ready for B1!",3)]),
];

const B1_LESSONS = [
  mkL("b1-01","Opinion Phrases & Connectors",30,"speaking",
    "CLB 5 core skill: express AND justify opinions! Openers: À mon avis, Selon moi, Il me semble que, Je suis convaincu(e) que. Justification: parce que, car (formal), puisque (since), étant donné que (given that). Concession: certes, il est vrai que, je comprends que. Conclusion: c'est pourquoi, donc, par conséquent. Practice giving opinions on: bilingualism, healthcare, immigration, remote work.",
    ["À mon avis / Selon moi","Je pense que / Je crois que","Il me semble que (it seems to me)","parce que / car / puisque","Tout d'abord... De plus... Cependant... En conclusion","c'est pourquoi (that's why)","je suis d'accord / pas d'accord","nuancer: il est vrai que... mais..."],
    [mcq("'À mon avis, c'est essentiel PARCE QUE cela aide à s'intégrer.' The underlined connector:",["introduces a contrast","introduces the reason/justification","introduces an example","introduces a conclusion"],1,"Parce que introduces the REASON after an opinion. This is THE essential CLB 5 structure: Opinion + parce que + Reason. Add an example for CLB 6: '...Par exemple, au travail, on parle souvent en français.'"),
     mcq("'Certes, c'est difficile, MAIS c'est possible.' 'Certes' means:",["therefore","certainly/admittedly","on the contrary","as a result"],1,"Certes = admittedly/certainly. It introduces a concession before presenting a counter-argument. 'Certes' + negative point + MAIS + positive counter = sophisticated CLB 5-6 argumentation structure!"),
     wr("Express your opinion on learning French in Canada",["à mon avis","selon moi","je pense que","je crois que","il me semble que"],"À mon avis, apprendre le français au Canada est essentiel parce que cela ouvre des portes professionnelles et facilite l'intégration sociale. De plus, cela témoigne du respect envers la culture québécoise. CLB 5 answer!")]),

  mkL("b1-02","Formal Email Structure",35,"writing",
    "CLB 5-6 writing: complete formal emails! Structure: 1) Objet: (Subject line — concise, specific) 2) Salutation: Bonjour Madame/Monsieur [Name], 3) Opening: Je vous écris au sujet de... / Suite à... / En réponse à... 4) Body: purpose + details + request (2-3 paragraphs) 5) Closing: Je vous remercie de l'attention... Dans l'attente... 6) Sign-off: Cordialement, + Full Name + Contact info.",
    ["Objet: (subject line required!)","Suite à notre conversation du...","Je vous écris pour vous informer que...","Je souhaite/Je souhaitais (I wish/wished)","Pourriez-vous (Could you — polite)","Je vous remercie à l'avance","Dans l'attente de votre réponse","Cordialement, [Prénom NOM]"],
    [mcq("'Suite à notre entretien téléphonique d'hier' opens an email. This means:",["I'm writing for the first time","Following our phone conversation yesterday","Before our meeting tomorrow","Regarding your last email"],1,"Suite à = following/further to. 'Suite à notre entretien téléphonique d'hier' = following our phone conversation yesterday. Very professional opening that refers to previous contact — shows continuity!"),
     mcq("The correct closing sequence is:",["Merci. Bye!","Je vous remercie. Cordialement, [Name]","Au revoir et bonne journée!","Merci beaucoup! À bientôt!"],1,"Je vous remercie de l'attention portée à ma demande. Cordialement, [Full Name]. This is THE standard professional email closing in Canada. 'Cordialement' is universally professional — not too formal, not too casual."),
     wr("Write an email subject line about requesting a document",["objet : demande","objet: demande","objet : request","objet : suivi"],"Objet : Demande de [document] — Dossier [number]. Example: 'Objet : Demande de relevé bancaire — Compte 12345.' Subject lines should be specific enough that the recipient knows the topic without opening the email!")]),

  mkL("b1-03","Subjunctive: Introduction",35,"writing",
    "The subjunctive mood expresses doubt, wish, emotion, or necessity. Most common triggers: il faut que (necessary), je veux que (I want), il est important que, bien que (although), pour que (so that), à moins que (unless), avant que (before). Formation: ils-form present → drop -ent → add: -e, -es, -e, -ions, -iez, -ent. Irregular: être→soit, avoir→ait, aller→aille, faire→fasse, pouvoir→puisse.",
    ["trigger + que + subjonctif","il faut que tu parles","je veux qu'il vienne","bien qu'elle soit fatiguée","pour que nous comprenions","avant qu'il parte","être → que je sois, que tu sois...","avoir → que j'aie, que tu aies..."],
    [mcq("'Il faut que vous ___ ce formulaire.' (remplir — to fill out)",["remplissez","remplissiez","remplir","remplirez"],1,"Remplissiez = subjonctif of remplir for vous. Formation: ils remplissent → rempliss → vous remplissiez. 'Il faut que' ALWAYS triggers subjunctive! 'Il faut que vous remplissiez ce formulaire' = You must fill out this form."),
     mcq("'Bien qu'il ___ fatigué, il travaille.' (être)",["est","était","soit","sera"],2,"Soit = subjonctif of être. 'Bien que' ALWAYS triggers subjunctive! 'Bien qu'il soit fatigué' = although he is tired. Memorize: être→soit, avoir→ait — these are the two most common irregular subjunctives!"),
     wr("Complete: 'Je veux que tu ___ (venir) à la réunion.'",["viennes"],"Viennes = subjonctif of venir. 'Je veux que tu viennes' = I want you to come. Venir in subjunctive: que je vienne, que tu viennes, qu'il vienne, que nous venions, que vous veniez, qu'ils viennent. Irregular — must memorize!")]),

  // ── B1 LESSONS 4–40 (real content) ──────────────────────────────────────────
  mkL("b1-04","Passive Voice",30,"writing",
    "The passive voice shifts focus from WHO does the action to WHAT is affected! Active: 'Le médecin examine le patient.' → Passive: 'Le patient est examiné par le médecin.' Formula: être (conjugated) + past participle (agrees with subject!) + par + agent (optional). All tenses work: présent (est examiné), passé composé (a été examiné), imparfait (était examiné), futur (sera examiné). Used widely in formal French writing, news, and official documents.",
    ["être + participe passé (agreement!)","par + agent (by whom)","Le rapport est rédigé par... (is written by)","Le dossier a été approuvé (has been approved)","La décision sera prise (will be made)","Votre demande est traitée (your request is being processed)","On + actif = passif implicite","Présent: est + pp | PC: a été + pp | Futur: sera + pp"],
    [mcq("'La décision a été prise par le comité.' — What is the subject?",["le comité","la décision","prise","a"],1,"La décision = subject of the passive sentence. The committee (le comité) is the AGENT (introduced by 'par'). In passive: subject receives the action. 'La décision a été prise' = The decision was made. Used constantly in formal Canadian documents!"),
     mcq("Active: 'L'infirmière administre les médicaments.' Passive:",["Les médicaments administrent l'infirmière","Les médicaments sont administrés par l'infirmière","Les médicaments a été administrée","L'infirmière est administrée par les médicaments"],1,"Les médicaments sont administrés par l'infirmière — sont (present of être) + administrés (pp agrees with les médicaments = masculine plural → -s). By = par. The agent (l'infirmière) follows par!"),
     mcq("In a government letter: 'Votre demande sera traitée dans les 30 jours.' This means:",["Your request was processed 30 days ago","Your request will be processed within 30 days","Your request is processing for 30 days","Your request must be submitted in 30 days"],1,"Sera traitée = will be processed (futur passif). 'Dans les 30 jours' = within 30 days. This exact phrase appears on immigration documents, healthcare applications, and government correspondence in Canada!"),
     wr("Convert to passive: 'Le gouvernement a approuvé la demande.'",["la demande a été approuvée par le gouvernement"],"La demande a été approuvée par le gouvernement — passé composé passif: a été + approuvée (agreement with la demande = feminine singular → -e). This passive structure is extremely common in official Canadian letters and news articles!")]),

  mkL("b1-05","Relative Clauses: Dont (Full Use)",25,"writing",
    "Master all uses of DONT! DONT replaces: de + noun (je parle DE lui → l'homme dont je parle), possession (il a une fille, le mari DE cette fille → la femme dont le mari travaille), and after many verbs/adjectives that take de: avoir besoin de, être fier de, avoir peur de, se souvenir de, se plaindre de, être content de, parler de, avoir envie de. DONT vs DUQUEL: dont is preferred, duquel only with preposition + de combinations (à l'intérieur duquel).",
    ["dont = de qui/de quoi/duquel","parler de → l'homme dont je parle","avoir besoin de → le document dont j'ai besoin","être fier de → l'enfant dont il est fier","se souvenir de → l'événement dont je me souviens","se plaindre de → le problème dont il se plaint","possession: la femme dont le mari est médecin","dont vs duquel (duquel after prep + de)"],
    [mcq("'C'est le sujet ___ je me souviens le mieux.' (se souvenir DE)",["que","qui","dont","lequel"],2,"Dont — se souvenir DE → dont. 'C'est le sujet dont je me souviens le mieux' = the subject I remember best. Dont replaces 'de ce sujet'. Classic dont usage with a verb that takes de!"),
     mcq("'C'est l'appartement ___ le loyer est très élevé.' (possession)",["que","qui","dont","lequel"],2,"Dont for possession! 'L'appartement dont le loyer est élevé' = the apartment whose rent is high. Dont replaces 'de cet appartement' in: 'l'appartement → le loyer DE cet appartement est élevé.' Dont = whose for possession with nouns!"),
     wr("Complete: 'C'est la situation ___ nous nous plaignons.' (se plaindre DE)",["dont"],"C'est la situation dont nous nous plaignons — se plaindre DE → dont. 'Nous nous plaignons DE cette situation' → 'la situation dont nous nous plaignons.' Master this pattern and you'll handle 90% of dont uses in B1 French!")]),

  mkL("b1-06","Indirect Speech: Full Coverage",30,"writing",
    "Complete indirect speech (discours indirect) including questions and commands! Statements: 'Je viens demain' → Il dit qu'il viendra demain. Questions: 'Est-ce que tu comprends?' → Il demande si je comprends. Wh-questions: 'Où habitez-vous?' → Il demande où j'habite. Commands: 'Venez!' → Il dit de venir (de + infinitif!). Tense changes when reporting PAST speech: présent→IMP, futur→conditionnel, PC→PQP. Pronouns and time words change too!",
    ["déclaration: il dit que + phrase","question oui/non: il demande si...","question ouverte: il demande où/quand/comment...","ordre: il dit de + infinitif","présent → imparfait (past speech)","futur → conditionnel (past speech)","PC → plus-que-parfait (past speech)","demain → le lendemain, hier → la veille"],
    [mcq("Direct: 'Appelez-moi demain!' → Indirect (past): Elle a dit de...",["l'appeler le lendemain","qu'elle appelle le lendemain","si je l'appelais","l'appeler demain"],0,"Elle a dit de l'appeler le lendemain — command → de + infinitive. 'Appeler' stays infinitive. 'Demain' → 'le lendemain' (reported past). 'Elle' = she who gave the command. 'Me' → 'la' (pronoun change)!"),
     mcq("'Est-ce que vous aimez le Canada?' → He asked...",["il a demandé que j'aime le Canada","il a demandé si j'aimais le Canada","il a demandé d'aimer le Canada","il a demandé où j'aimais le Canada"],1,"Si j'aimais — yes/no question → si. Past speech → présent (aimez) → imparfait (aimais). Pronoun: vous → je (perspective shift). 'Il a demandé si j'aimais le Canada' = He asked whether I liked Canada."),
     wr("Report: 'Où habitez-vous depuis votre arrivée?' (past speech)",["il a demandé où j'habitais depuis mon arrivée","elle a demandé où j'habitais depuis mon arrivée"],"Il/Elle a demandé où j'habitais depuis mon arrivée — wh-question 'où' stays. Présent (habitez) → imparfait (habitais). Vous → je. 'Votre' → 'mon'. This pronoun shifting is a key B1 grammar skill!")]),

  mkL("b1-07","Plus-que-parfait (Pluperfect)",25,"writing",
    "The pluperfect = the past of the past! Used when one past action happened BEFORE another past action. Formula: avoir/être (imparfait) + past participle. J'avais mangé (I had eaten), Elle était partie (She had left), Ils avaient fini (They had finished). Key uses: 'Quand je suis arrivé, elle était déjà partie' (When I arrived, she had already left). Also used in type 3 conditionals: 'Si j'avais su, j'aurais décidé autrement.'",
    ["j'avais + pp (I had done)","il/elle était + pp (être verbs — with agreement!)","nous avions + pp","déjà (already — with PQP)","après que + PQP","Quand je suis arrivé, elle avait déjà...","Si j'avais su (type 3 conditional)","PQP = plus-que-parfait / pluperfect"],
    [mcq("'Quand j'ai appelé, elle ___ déjà ___.' (partir — she left before I called)",["est, partie","avait, parti","était, partie","a, partie"],2,"Était partie = pluperfect of partir (être verb — agreement with elle → partie). She left BEFORE I called. Imparfait of être (était) + partie (pp with agreement). 'Déjà' confirms the 'already before' meaning!"),
     mcq("'Il avait déjà rempli le formulaire quand le bureau a ouvert.' This means:",["He filled out the form after the office opened","He filled out the form at the same time the office opened","He had already filled out the form before the office opened","He will fill out the form when the office opens"],2,"Avait rempli (PQP) happened BEFORE a ouvert (PC). The PQP action is further back in time. 'Déjà' reinforces 'already done before'. Very common in narratives and formal French writing!"),
     wr("Say 'When I arrived in Canada, I had already studied French for 6 months'",["quand je suis arrivé au canada, j'avais déjà étudié le français pendant 6 mois","quand je suis arrivée au canada, j'avais déjà étudié le français pendant 6 mois"],"Quand je suis arrivé(e) au Canada, j'avais déjà étudié le français pendant 6 mois. — Perfect PQP sentence! Arrives in Canada (PC) but had been studying (PQP = before arrival). 'Pendant' + completed duration is correct here!")]),

  mkL("b1-08","Futur Antérieur",25,"writing",
    "The future perfect — an action that will be COMPLETED before a future point! Formula: avoir/être (futur simple) + past participle. J'aurai fini (I will have finished), Elle sera partie (She will have left). Trigger phrases: quand (when), dès que/aussitôt que (as soon as), lorsque (when), après que (after) — ALWAYS use futur antérieur, not futur simple! Example: 'Dès que j'aurai reçu ma réponse, je vous contacterai.'",
    ["j'aurai + pp (I will have done)","être verbs: elle sera partie","dès que / aussitôt que + futur antérieur","quand tu auras fini, appelle-moi","après qu'il sera parti (after he has left)","Quand j'aurai obtenu ma citoyenneté...","Dès que vous aurez rempli ce formulaire...","le futur dans le futur"],
    [mcq("'Dès que tu ___ (finir) ton travail, nous partirons.' Correct form:",["finiras","auras fini","avais fini","finissais"],1,"Auras fini = futur antérieur. After 'dès que' with two future events: the FIRST to be completed uses futur antérieur, the SECOND uses futur simple. 'Dès que tu AURAS FINI (1st), nous PARTIRONS (2nd).'"),
     mcq("'Quand j'aurai obtenu ma résidence permanente, je pourrai travailler librement.' This means:",["After I get my PR, I'll be able to work freely","I got my PR and now I can work","I want to get my PR to work","When I had my PR, I worked"],0,"Aurai obtenu = future perfect (will have obtained = by that point). Pourrai = futur simple (will be able to). Classic futur antérieur + futur simple combination for sequential future events!"),
     wr("Say 'Once I've passed the TEF exam, I'll apply for citizenship'",["dès que j'aurai passé le tef, je ferai une demande de citoyenneté","quand j'aurai réussi le tef, je demanderai la citoyenneté"],"Dès que j'aurai passé le TEF, je ferai une demande de citoyenneté — futur antérieur (aurai passé) + futur simple (ferai). This sentence expresses a real Canadian newcomer goal perfectly!")]),

  mkL("b1-09","Pronoun Order (Multiple Pronouns)",25,"writing",
    "When multiple object pronouns appear in one sentence, they follow strict order! RULE: NE + [me/te/se/nous/vous] + [le/la/les] + [lui/leur] + [y] + [en] + VERB + PAS. Examples: 'Il me le donne' (he gives it to me), 'Elle le lui a envoyé' (she sent it to him), 'Ils nous en ont parlé' (they told us about it), 'Je t'y emmène' (I'm taking you there). In imperatives: positive changes order — verb + direct + indirect: 'Donne-le-moi!' Negative stays normal: 'Ne me le donne pas.'",
    ["ordre: me/te/se/nous/vous > le/la/les > lui/leur > y > en","Il me le donne (gives it to me)","Je le lui envoie (send it to him/her)","Elle nous en parle (tells us about it)","On t'y amène (takes you there)","Impératif positif: Donne-le-moi! (reversed order)","Impératif négatif: Ne me le donne pas (normal order)"],
    [mcq("'Je ___ enverrai.' (I'll send it to him — le document, to Paul)",["le lui","lui le","l'en","y lui"],0,"Le lui — direct object (le) comes BEFORE indirect object (lui) in French. 'Je lui enverrai le document' → 'Je le lui enverrai.' Always: le/la/les before lui/leur in pronoun combinations!"),
     mcq("Positive imperative: 'Envoie-lui le document!' With both pronouns:",["Envoie-le-lui!","Envoie-lui-le!","Le-lui envoie!","Lui-le envoie!"],0,"Envoie-le-lui! — In positive imperatives: direct object (le) comes BEFORE indirect object (lui). Notice: reversed from statement order! 'Donne-le-moi, montre-le-leur, dis-le-lui.' Hyphen connects all!"),
     wr("Replace both: 'Elle a envoyé le dossier à l'employeur.'",["elle le lui a envoyé"],"Elle le lui a envoyé — le = le dossier (direct, m.sg.), lui = à l'employeur (indirect, singular). Order: le before lui. PC agreement: envoyé agrees with 'le' (direct object pronoun placed BEFORE avoir) → envoyé (masculine singular, no change here). Advanced CLB 6 grammar!")]),

  mkL("b1-10","The Gerund (Gérondif)",20,"writing",
    "The gerund = EN + present participle (-ant form). Same time: 'Il lit en mangeant' (He reads while eating — simultaneously). Cause: 'En travaillant dur, tu réussiras' (By working hard, you'll succeed). Condition: 'En appelant maintenant, vous aurez une réduction' (By calling now, you'll get a discount). Both verbs must have the SAME subject! Formation: nous-form present → drop -ons → add -ant. Irregular: être→étant, avoir→ayant, savoir→sachant.",
    ["en + participe présent (-ant)","simultanéité: il parle en conduisant (while driving)","moyen: en travaillant dur (by working hard)","condition: en appelant maintenant (by calling now)","formation: nous-form → drop -ons → -ant","même sujet pour les deux verbes!","irréguliers: étant, ayant, sachant","tout en + gérondif (while at the same time)"],
    [mcq("'Il a appris le français en regardant des films.' The gerund expresses:",["a result","the means/method","a simultaneous unrelated action","a condition"],1,"En regardant = by watching — the gerund expresses METHOD or MEANS. 'How did he learn?' → 'By watching films.' This is the most common gerund use: explaining HOW something is accomplished!"),
     mcq("'Elle chante en cuisinant.' This means:",["She cooked and then sang","She sings to cook","She sings while cooking (simultaneously)","She used to sing while cooking"],2,"En cuisinant = while cooking — simultaneous actions by the SAME subject (elle). Both verbs share the same subject! 'Il conduit en téléphonant' (drives while talking on phone) — same structure."),
     wr("Express how to improve your French using the gerund",["en pratiquant","en lisant","en écoutant","en parlant","en regardant"],"En pratiquant tous les jours, on améliore son français rapidement. — en + pratiquant (method). This is a perfect motivational sentence! 'C'est en forgeant qu'on devient forgeron' = practice makes perfect (literal: it's by forging that you become a blacksmith) — famous French proverb!")]),

  mkL("b1-11","Vocabulary: Workplace & Professional French",30,"speaking",
    "Professional vocabulary for Canadian workplaces! Positions: le/la gestionnaire (manager), l'employé(e) (employee), le/la collègue (colleague), le/la patron(ne) (boss), le/la superviseur(e) (supervisor), le/la directeur/directrice (director). Tasks: rédiger (write/draft), soumettre (submit), approuver (approve), réviser (revise), collaborer (collaborate), déléguer (delegate), présenter (present). Meetings: ordre du jour (agenda), compte rendu (minutes), échéance (deadline), priorité (priority).",
    ["le gestionnaire (manager)","l'échéance (deadline)","l'ordre du jour (agenda)","le compte rendu (meeting minutes)","rédiger un rapport (write a report)","soumettre (to submit)","approuver/valider (to approve)","collaborer avec (to collaborate with)","la réunion / la conférence","le télétravail (remote work)","en présentiel (in person)"],
    [mcq("'Pouvez-vous me faire parvenir le compte rendu de la réunion?' means:",["Can you attend the meeting?","Can you send me the meeting minutes?","Can you set the meeting agenda?","Can you cancel the meeting?"],1,"Compte rendu = meeting minutes (record of what was discussed and decided). 'Faire parvenir' = to send/forward (formal). 'Pouvez-vous me faire parvenir' = Can you send me. Standard professional request in any Canadian office!"),
     mcq("'Le projet a une échéance au vendredi' means:",["The project starts on Friday","The project deadline is Friday","The project will be reviewed on Friday","The project was submitted on Friday"],1,"Échéance = deadline. 'L'échéance est vendredi' or 'À remettre pour vendredi' = deadline is Friday. Very common in Canadian workplaces. 'Quelle est l'échéance de ce rapport?' = When is this report due?"),
     wr("Tell your colleague you'll send the report by end of day",["je vous enverrai le rapport en fin de journée","je t'enverrai le rapport avant la fin de la journée","je vais vous envoyer le rapport aujourd'hui"],"Je vous enverrai le rapport en fin de journée — futur simple (professionnel) + en fin de journée (by end of day). In workplace emails: 'Je me permets de vous faire parvenir le rapport demandé en pièce jointe.' (I'm sending you the requested report as an attachment.)")]),

  mkL("b1-12","Vocabulary: Politics & Civic Life",25,"reading",
    "Understanding Canadian civic and political vocabulary! Le gouvernement fédéral (federal government), le gouvernement provincial (provincial), la municipalité (municipality), le premier ministre (Prime Minister), le chef du gouvernement (head of government), les élections (elections), voter / le vote (to vote / vote), les droits (rights), les devoirs (duties), la démocratie (democracy), la citoyenneté (citizenship), l'immigration (immigration), les impôts (taxes).",
    ["le gouvernement fédéral/provincial","le premier ministre (PM)","les élections (elections)","voter (to vote)","les droits et devoirs (rights and duties)","la citoyenneté canadienne","les impôts (taxes) — déclaration d'impôts","l'Assemblée nationale (Quebec legislature)","la Chambre des communes (House of Commons)","le Sénat (Senate)","la Constitution / la Charte des droits"],
    [mcq("'L'Assemblée nationale' is:",["the Canadian federal parliament","Quebec's provincial legislature","the Senate of Canada","the Supreme Court of Canada"],1,"L'Assemblée nationale = Quebec's provincial legislature (equivalent to a 'parliament' at provincial level). Federal parliament = la Chambre des communes (House of Commons). Each province has its own legislature!"),
     mcq("'La déclaration de revenus' is:",["a declaration of your rights","your annual income tax return","your employment contract","your citizenship application"],1,"Déclaration de revenus = income tax return (what you file with Revenu Canada / ARC). In Quebec: also file with Revenu Québec! Deadline: April 30 each year. 'Avez-vous fait votre déclaration de revenus?' = Have you filed your tax return?"),
     wr("Write a sentence about your rights as a newcomer in Canada",["en tant que résident permanent","j'ai le droit de","les résidents permanents ont le droit","la charte canadienne"],"En tant que résident permanent, j'ai le droit de travailler, d'étudier et d'accéder aux services de santé au Canada. — Rights sentence for CLB 5 speaking! Perfect for citizenship interview preparation.")]),

  mkL("b1-13","Vocabulary: Environment & Sustainability",20,"reading",
    "Environmental vocabulary at B1 level for current affairs and CLB tasks! Le développement durable (sustainable development), la transition énergétique (energy transition), les énergies fossiles (fossil fuels), l'énergie éolienne (wind energy), le solaire (solar), l'hydroélectricité (hydroelectricity — Quebec's specialty!), la biodiversité (biodiversity), les espèces menacées (endangered species), la déforestation, la pollution de l'air/de l'eau, le protocole de Kyoto, l'accord de Paris.",
    ["le développement durable (sustainable dev)","l'hydroélectricité (Quebec's main energy source!)","les énergies renouvelables","la transition énergétique","la biodiversité","les espèces menacées (endangered species)","la pollution atmosphérique","l'empreinte écologique (ecological footprint)","les matières résiduelles (waste/garbage)","zéro déchet (zero waste)"],
    [mcq("Quebec's main source of electricity is:",["le charbon (coal)","le pétrole (oil)","l'hydroélectricité (hydropower)","le nucléaire (nuclear)"],2,"Quebec gets ~95% of its electricity from hydropower (barrages hydrauliques). Hydro-Québec is the provincial utility. This makes Quebec's electricity one of the cleanest in North America — an important advantage for the environment!"),
     mcq("'Les espèces menacées' refers to:",["endangered species","energy sources","recycling programs","threatened weather patterns"],0,"Espèces menacées = endangered species. 'Espèce' = species. 'Menacée' = threatened/endangered. 'Le gouvernement protège les espèces menacées dans les parcs nationaux.' This vocabulary appears in CLB 5-6 reading tasks about environmental policy!"),
     wr("Give your opinion on Quebec's use of hydroelectricity",["à mon avis, l'hydroélectricité","selon moi, c'est","je pense que l'énergie hydraulique","l'hydroélectricité est"],"À mon avis, l'hydroélectricité est un avantage considérable pour le Québec, car c'est une énergie propre et renouvelable. Cependant, la construction de grands barrages a des impacts sur l'environnement et les communautés autochtones. — Balanced B1 opinion!")]),

  mkL("b1-14","Vocabulary: Technology & Digital Life",20,"reading",
    "Digital vocabulary at B1 level! L'intelligence artificielle (AI), l'apprentissage automatique (machine learning), les données (data), la confidentialité des données (data privacy), la cybersécurité, le télétravail (remote work), la visioconférence (video conference), les applications mobiles, le cloud/nuage informatique (cloud computing), l'économie numérique (digital economy), la fracture numérique (digital divide), la désinformation (misinformation).",
    ["l'intelligence artificielle (AI)","les données personnelles (personal data)","la confidentialité (privacy)","la cybersécurité","le télétravail (remote work)","la visioconférence","la désinformation (misinformation)","la fracture numérique (digital divide)","l'économie numérique","les réseaux sociaux (social media)","la protection des données (RGPD in EU, LPRPDE in Canada)"],
    [mcq("'La fracture numérique' refers to:",["breaking a digital device","the gap between people with and without digital access","digital file corruption","a type of cyberattack"],1,"La fracture numérique = digital divide — the gap between people who have access to technology and those who don't. Important Canadian social issue, especially for seniors and remote communities. 'Réduire la fracture numérique' = reducing the digital gap is a policy goal!"),
     mcq("In Canada, personal data protection is governed by:",["RGPD","LPRPDE (Loi sur la protection des renseignements personnels)","NSA","CRTC only"],1,"LPRPDE (Loi sur la protection des renseignements personnels et les documents électroniques) = Canada's federal privacy law. Quebec also has Law 25 (updated 2022 — stricter than federal!). Employers and companies must comply!"),
     wr("Give your opinion on AI in the workplace",["à mon avis, l'intelligence artificielle","selon moi, les technologies","l'ia va","l'intelligence artificielle peut"],"À mon avis, l'intelligence artificielle va transformer le marché du travail. Certes, elle peut remplacer certains emplois, mais elle créera aussi de nouvelles opportunités. Il est essentiel de se former continuellement. — Balanced B1 opinion on a current affairs topic!")]),

  mkL("b1-15","Writing: Opinion Essay (120 words)",35,"writing",
    "Write a structured opinion essay at CLB 5-6 level! Full structure: 1) Introduction (present topic + state position — 2-3 sentences). 2) Premier argument + justification + example. 3) Deuxième argument + justification + example. 4) Concession (acknowledge the other side — optional but shows sophistication). 5) Conclusion (restate + broader perspective). Target: 100-150 words. Key connectors: D'abord, De plus, Cependant, En revanche, Ainsi, En conclusion.",
    ["Introduction: présenter le sujet + position","Argument 1: D'abord,... parce que...","Argument 2: De plus,...","Concession: Certes,... Cependant/Néanmoins,...","Conclusion: En conclusion, Ainsi,...","100-150 mots (CLB 5-6)","Registre formel (vous, pas d'argot)","Connecteurs logiques tout au long","Exemples concrets du contexte canadien"],
    [mcq("The CONCESSION in an essay serves to:",["add a third argument","show you only know one side","acknowledge the opposing view before reinforcing yours","end the essay"],2,"Concession = acknowledging the other side. 'Certes, certains affirment que... Cependant, je pense que...' This shows critical thinking and fairness — rewarded in CLB 6+ writing! It makes your argument stronger, not weaker."),
     mcq("Which connector introduces a CONCLUSION?",["De plus","D'abord","En conclusion","Cependant"],2,"En conclusion / Ainsi / En somme / Pour conclure — all introduce the conclusion. The conclusion should: restate your position (in different words) + broader perspective or call to action. Don't introduce new arguments in the conclusion!"),
     wr("Write an introduction for: 'L'apprentissage du français est-il nécessaire pour les immigrants au Canada?'",["à mon avis","selon moi","l'apprentissage du français","je pense que","dans cet essai"],"L'apprentissage du français représente un enjeu majeur pour les immigrants souhaitant s'intégrer au Canada. À mon avis, maîtriser le français est non seulement nécessaire mais indispensable pour réussir professionnellement et socialement. Dans ce qui suit, j'exposerai les raisons de cette conviction. — Perfect CLB 5 essay introduction!")]),

  mkL("b1-16","Writing: Formal Complaint Letter",30,"writing",
    "Write a formal complaint letter in French — a CLB 6 core writing task! Full structure: 1) Your contact info (top right). 2) Recipient info. 3) City and date. 4) Object line (Objet: Réclamation concernant...). 5) Salutation. 6) Reference to the problem (date, details, reference numbers). 7) Description of problem and its consequences. 8) Your request. 9) Deadline. 10) Threat of escalation (optional). 11) Closing. 12) Signature. Language: impersonal, polite but firm.",
    ["Objet: Réclamation / Plainte concernant...","Suite à [incident du date]...","Malgré [ma demande du date], le problème persiste","Les conséquences sont les suivantes:","Je vous demande de bien vouloir...","Un délai de X jours ouvrables","À défaut de réponse satisfaisante, je me verrai contraint de...","Veuillez agréer l'expression de mes salutations distinguées","La Commission de protection du consommateur / l'OPC"],
    [mcq("'Veuillez agréer, Madame/Monsieur, l'expression de mes salutations distinguées' is:",["a casual closing","a formal letter closing formula (required in formal French letters)","an opening greeting","an apology formula"],1,"This IS the required formal closing in French professional letters! It's the equivalent of 'Yours sincerely' but much more elaborate. Shorter alternatives: 'Cordialement' (neutral), 'Avec mes salutations distinguées' (formal). Always end formal complaint letters with this!"),
     mcq("What MUST a formal complaint letter include?",["just your name and complaint","dates, reference numbers, specific amounts, and a clear request","only your opinion about the problem","the full history of your relationship with the company"],1,"Dates + reference numbers + specific amounts + clear request = the four essential elements. Without these, your complaint is easy to ignore. 'Le [date], j'ai acheté [product, reference #X], au prix de [amount]. Depuis lors, [problem]. Je vous demande de [specific request].'"),
     wr("Write the object line for a complaint about incorrect billing",["objet : réclamation concernant une erreur de facturation","objet: contestation d'une facture","objet : plainte - erreur de facturation"],"Objet : Réclamation concernant une erreur de facturation — Reference: [account/invoice number]. The object line should be specific enough that the recipient understands immediately. Include reference numbers when possible!")]),

  mkL("b1-17","Writing: Request for Information",25,"writing",
    "Write formal information requests — needed for immigration documents, professional licensing, school registration. Formula: 1) Explain who you are (briefly). 2) State what information you need (specifically). 3) Explain why you need it. 4) Ask for the preferred format (written confirmation, official document, etc.). 5) Give contact info. 6) Thank them. Key phrases: Je me permets de vous contacter afin de..., Je souhaiterais obtenir des renseignements concernant..., Pourriez-vous m'indiquer..., À cet effet...",
    ["Je me permets de vous contacter afin de... (I'm reaching out to...)","Je souhaiterais obtenir des renseignements (I would like to obtain information)","Pourriez-vous m'indiquer... (Could you tell me...)","À cet effet, (to this end)","En vous remerciant à l'avance (thanking you in advance)","Si vous avez besoin d'informations complémentaires... (if you need additional info)","ci-joint (attached/enclosed)","Dans l'attente de votre réponse (awaiting your reply)"],
    [mcq("'Je me permets de vous contacter' means:",["I'm forcing you to read this","I'm reaching out to you / I'm taking the liberty of contacting you","I'm sorry to bother you","I'm writing this complaint"],1,"Je me permets de vous contacter = I'm taking the liberty of contacting you / I'm reaching out. Very polite opening — acknowledges that you're initiating contact. Common in professional and government correspondence in Canada!"),
     mcq("'Pourriez-vous m'indiquer les documents requis?' means:",["Could you require my documents?","Could you indicate/tell me what documents are required?","Are my documents required?","Could you indicate that documents exist?"],1,"Pourriez-vous m'indiquer = could you tell me/indicate. 'Les documents requis' = the required documents. Perfect for asking immigration offices, licensing bodies, or employers what you need to submit!"),
     wr("Write a sentence requesting information about professional license recognition",["je souhaiterais obtenir des renseignements","pourriez-vous m'indiquer","je me permets de vous contacter","j'aimerais savoir comment"],"Je me permets de vous contacter afin d'obtenir des renseignements concernant la reconnaissance de mes titres de compétences étrangers dans le domaine de [profession] au Québec. — Perfect! Professional credential recognition is crucial for many newcomers to Canada.")]),

  mkL("b1-18","Writing: Explain a Process",25,"writing",
    "Write process explanations — used for instructions, procedures, how-tos, and professional documentation. Language features: sequence connectors (d'abord, ensuite, puis, après, finalement), imperatives (remplissez, signez, soumettez), passive voice (le formulaire est envoyé), impersonal expressions (il faut, il est nécessaire de, on doit). Format: numbered steps OR flowing paragraph. Canadian government websites use process language constantly.",
    ["D'abord, il faut / vous devez (first, you must)","Ensuite, (then)","Puis / Après avoir + pp, (after having done)","Il est nécessaire de (it is necessary to)","Veillez à (make sure to)","Une fois que vous avez + pp, (once you have)","Finalement / Pour terminer, (finally)","N'oubliez pas de (don't forget to)","En cas de problème, (in case of a problem)"],
    [mcq("'Après avoir rempli le formulaire' means:",["Before filling out the form","While filling out the form","After having filled out the form","If you fill out the form"],2,"Après avoir + past participle = after having done. 'Après avoir rempli' = after (having) filled out. Both verbs must have the SAME subject! 'Après avoir rempli le formulaire, soumettez-le en ligne.' = After filling out the form, submit it online."),
     mcq("'Veillez à conserver une copie de tous vos documents' means:",["Make sure to conserve all your documents","Be careful to keep a copy of all your documents","You must not keep copies","Please submit copies of all documents"],1,"Veillez à = make sure to / please ensure that (imperative of veiller). 'Veillez à conserver' = make sure to keep. A softer imperative used in official instructions. Critical advice: always keep copies of documents submitted to Canadian authorities!"),
     wr("Explain in 2 steps how to register for the RAMQ health card",["d'abord, remplissez","ensuite, soumettez","premièrement","il faut","vous devez remplir"],"D'abord, remplissez le formulaire d'inscription en ligne sur le site de la RAMQ. Ensuite, envoyez les documents requis (passeport, preuve d'adresse, statut d'immigration) par courrier ou en personne. — Clear 2-step process in CLB 5 instructional French!")]),

  mkL("b1-19","Speaking: 2-Minute Opinion Monologue",30,"speaking",
    "Deliver a structured 2-minute opinion monologue — THE key CLB 5-6 speaking task! Structure: 1) Introduction (state topic + position — 15 sec). 2) Argument 1 + example (30 sec). 3) Argument 2 + example (30 sec). 4) Concession (acknowledge other side — 20 sec). 5) Conclusion (restate + broader point — 25 sec). Practice topics: bilingualism in Canada, immigration policy, remote work, healthcare access, environmental policy. Use sophisticated connectors throughout.",
    ["Introduction: Le sujet d'aujourd'hui est... À mon avis...","Tout d'abord, je pense que... En effet,...","De plus, il est indéniable que... Par exemple,...","Certes, certains affirment que... Néanmoins,...","En conclusion, il est clair que... C'est pourquoi...","Remplir 2 minutes sans pauses longues","Varier les connecteurs (ne pas répéter 'parce que')","Exemples concrets du contexte canadien","Voix assurée, rythme modéré, articulation"],
    [mcq("In a 2-minute monologue, the concession (e.g. 'Certes... néanmoins...') shows:",["you've run out of arguments","you lack confidence in your position","critical thinking and awareness of other perspectives","you agree with the opposing view"],2,"Concession = intellectual maturity. 'Certes, il est vrai que certains estiment que X. Cependant, à mon avis...' Acknowledging the other side then returning to your position = sophisticated argumentation. CLB 6 assessors look for this!"),
     sp("Speak ~30 seconds: introduce the topic and state your position on « Le bilinguisme est-il un atout pour le Canada? ». Use an opener (À mon avis / Selon moi) + your position + a one-line preview of your arguments.","À mon avis, le bilinguisme est un véritable atout pour le Canada. Non seulement il renforce l'unité nationale, mais il ouvre aussi des portes économiques. Dans les prochaines minutes, j'expliquerai pourquoi.",["à mon avis","bilinguisme","atout","canada","selon moi"],"A strong intro = opener + clear position + preview. Keep a confident, steady pace and don't rush."),
     sp("Now deliver a full mini-monologue (~60 sec) on « Le télétravail : avantages et limites ». Structure: position → argument + exemple → concession (Certes… cependant…) → conclusion.","À mon avis, le télétravail présente plus d'avantages que d'inconvénients. Tout d'abord, il offre une grande flexibilité : par exemple, on évite de longs trajets. Certes, il peut isoler les employés ; cependant, des outils comme la visioconférence atténuent ce problème. En conclusion, le télétravail, bien encadré, est bénéfique.",["télétravail","tout d'abord","par exemple","certes","cependant","en conclusion"],"A complete CLB 6 monologue: position, argument + example, concession + rebuttal, conclusion. Vary your connectors — don't repeat 'parce que'."),
     wr("Write a 3-sentence introduction for: 'Faut-il rendre le français obligatoire au travail au Québec?'",["à mon avis","selon moi","l'utilisation du français","je pense que","cette question","le français au travail"],"La question de l'obligation du français au travail au Québec est au cœur des débats sur l'identité culturelle et l'intégration économique. À mon avis, renforcer l'usage du français dans les milieux professionnels est non seulement justifié, mais nécessaire pour préserver la vitalité de la langue française. Dans les deux prochaines minutes, j'exposerai les raisons de cette conviction. — Perfect CLB 6 introduction!")]),

  mkL("b1-20","Speaking: Debate & Discussion",25,"speaking",
    "Participate in French debates and discussions — CLB 6 interactive speaking! Agreeing: Je suis d'accord avec vous parce que..., Tout à fait!, Vous avez raison, c'est vrai que... Disagreeing politely: Je ne partage pas tout à fait votre avis..., Je comprends votre point de vue, mais..., Permettez-moi de nuancer... Taking the floor: Si je peux me permettre..., J'aimerais ajouter que..., Pour rebondir sur ce que vous avez dit... Asking for clarification: Pourriez-vous préciser ce que vous entendez par...?",
    ["Je suis (tout à fait) d'accord (I fully agree)","Je ne partage pas votre avis (I don't share your view)","Je comprends votre point de vue, mais... (I understand but...)","Permettez-moi de nuancer (allow me to nuance)","Si je peux me permettre... (if I may...)","J'aimerais rebondir sur ce point (I'd like to build on this)","Pourriez-vous préciser? (Could you clarify?)","En d'autres termes,... (in other words)"],
    [mcq("'Je ne partage pas tout à fait votre avis' is:",["a polite way to strongly disagree","an agreement","a request for clarification","a conclusion"],0,"'Je ne partage pas tout à fait votre avis' = I don't quite share your view. 'Tout à fait' (completely/quite) actually softens it — it's not a TOTAL disagreement. Very polite way to disagree in French. Always follow with 'parce que...' or 'car je pense que...'"),
     sp("Your debate partner says: « Les nouveaux arrivants devraient apprendre l'anglais avant le français. » Disagree politely out loud: acknowledge their view, then nuance it with a reason.","Je comprends votre point de vue, mais permettez-moi de nuancer. Au Québec, le français est la langue officielle et la clé de l'intégration professionnelle. Apprendre le français d'abord ouvre donc plus de portes.",["je comprends votre point de vue","permettez-moi de nuancer","mais","au québec","le français"],"Polite disagreement = acknowledge + 'mais/cependant' + reason. This 'oui, mais' move is the core of CLB 6 interactive speaking."),
     sp("Take the floor and build on a point: respond to « Le coût de la vie augmente trop vite » by adding a related idea, starting with 'Pour rebondir sur ce point...'","Pour rebondir sur ce point, j'ajouterais que la hausse du logement touche surtout les jeunes familles. C'est pourquoi des mesures ciblées me semblent nécessaires.",["pour rebondir sur ce point","j'ajouterais","c'est pourquoi"],"'Pour rebondir sur ce point' shows active listening and lets you contribute smoothly — a hallmark of natural debate."),
     wr("Politely disagree with: 'Le français n'est pas important pour trouver du travail au Canada.'",["je ne partage pas votre avis","je comprends votre point de vue, mais","permettez-moi de nuancer","je suis en désaccord, car"],"Je comprends votre point de vue, mais je ne partage pas tout à fait cet avis. En effet, dans de nombreux secteurs au Canada, notamment au Québec, la maîtrise du français est un critère de sélection déterminant. — Polite, structured disagreement with evidence. CLB 6 debate skill!")]),

  mkL("b1-21","Speaking: Job Interview in French",30,"speaking",
    "Ace a French job interview! Preparation: research the company (rechercher l'entreprise), prepare for common questions. Common questions: Parlez-moi de vous (Tell me about yourself — 90 sec!), Quelles sont vos forces/faiblesses? (strengths/weaknesses?), Pourquoi voulez-vous travailler chez nous? (Why this company?), Où vous voyez-vous dans 5 ans? (Where do you see yourself in 5 years?), Avez-vous des questions? (Do you have questions?). Always: formal, confident, specific examples using STAR method.",
    ["Parlez-moi de vous (Tell me about yourself)","Mes points forts sont... (my strengths are)","Un axe d'amélioration pour moi est... (area for improvement)","Pourquoi ce poste? (Why this position?)","J'ai de l'expérience dans... (I have experience in)","La méthode STAR: Situation, Tâche, Action, Résultat","Avez-vous des questions pour nous? (Do you have questions?)","Merci pour cette opportunité (Thank you for this opportunity)"],
    [mcq("'Parlez-moi de vous' should be answered in approximately:",["30 seconds","1-2 minutes (structured: background, experience, goals)","5 minutes","10 minutes"],1,"1-2 minutes = ideal. Structure: 1) Brief background (30 sec), 2) Relevant experience (45 sec), 3) Why this role (30 sec). NOT your life story — focused on professional relevance. Practice until smooth and natural!"),
     sp("The interviewer asks: « Parlez-moi de vous. » Answer out loud (~60–90 sec): background → relevant experience → why this role. Keep it professional.","Je m'appelle [votre nom] et je suis arrivé(e) au Canada il y a deux ans. J'ai plus de cinq ans d'expérience dans le service à la clientèle. Depuis mon arrivée, j'ai perfectionné mon français tout en travaillant. Je postule pour ce poste car il correspond à mes compétences et à mon désir de m'investir à long terme.",["je m'appelle","expérience","j'ai travaillé","je postule","ce poste"],"A focused 'tell me about yourself': who you are, relevant experience, and why this role — not your whole life story."),
     sp("Now answer: « Quel est votre principal axe d'amélioration? » (your main area for improvement). Name a real one + what you're doing about it.","Un axe d'amélioration pour moi est la gestion du temps lorsque j'ai plusieurs projets. Pour y remédier, j'utilise maintenant des outils de planification, et mon organisation s'est nettement améliorée.",["un axe d'amélioration","gestion du temps","pour y remédier","s'est amélioré"],"Real weakness + concrete improvement = authentic and impressive. Avoid the fake 'I work too hard' answer."),
     wr("Describe your strongest professional quality in French",["mon point fort est","ma principale qualité est","je suis particulièrement","j'excelle dans"],"Mon point fort est ma capacité à m'adapter rapidement à de nouveaux environnements. Par exemple, lors de mon arrivée au Canada, j'ai appris le français tout en occupant un emploi à temps partiel. — Strength + concrete example from your Canadian experience = excellent interview answer!")]),

  mkL("b1-22","Listening: Extended Conversation",25,"listening",
    "Understand extended conversations at B1/CLB 5 level! Strategies: 1) Listen for topic changes (alors, maintenant, d'ailleurs, à propos de). 2) Identify speaker positions (agreement/disagreement markers). 3) Note opinions vs facts (je pense que = opinion, des études montrent que = fact). 4) Listen for examples (par exemple, c'est le cas de, notamment). Common conversation types: service calls, workplace discussions, family decisions, news interviews, community meetings.",
    ["Repérer les changements de sujet (topic shifts)","Distinguer opinion vs fait (je pense vs des études montrent)","Connecteurs de discussion: d'ailleurs, à propos, en plus","Accord/désaccord: exactement, c'est vrai, mais/cependant","Exemples: par exemple, notamment, c'est le cas de","Résumer ce qu'on a compris (summarize)","Poser des questions de clarification","CLB 5 listening: 3-5 min dialogue"],
    [mcq("In a discussion, 'D'ailleurs' signals:",["a strong disagreement","a contradiction","an additional related point (besides/moreover)","a question"],2,"D'ailleurs = besides/moreover/incidentally. It introduces an additional related point. 'Le français est important. D'ailleurs, au Québec, c'est la seule langue officielle.' Common in natural French conversation — signals fluency when you use it!"),
     li("Alors, pour ton déménagement, je te conseille de réserver le camion au moins deux semaines à l'avance. D'ailleurs, le premier juillet, presque tout le monde déménage au Québec, donc les camions partent très vite.","Qu'est-ce que la personne conseille de faire?",["Réserver le camion au moins deux semaines à l'avance","Déménager le premier juillet","Acheter son propre camion","Déménager tout seul"],0,"« Je te conseille de réserver le camion au moins deux semaines à l'avance. » The reason given: July 1 is moving day across Quebec, so trucks book up fast.",{diff:3,transcriptEn:"For your move, I'd advise booking the truck at least two weeks ahead. Besides, on July 1 almost everyone in Quebec moves, so trucks go fast."}),
     li("Honnêtement, je trouve que la réunion a été utile. Mais selon les chiffres présentés, les ventes ont baissé de huit pour cent ce trimestre. Le directeur a donc proposé une nouvelle stratégie pour le mois prochain.","D'après l'enregistrement, qu'est-ce qui est un FAIT (et non une opinion)?",["La réunion a été utile","Les ventes ont baissé de 8 % ce trimestre","La nouvelle stratégie va réussir","La réunion était trop longue"],1,"'Je trouve que la réunion a été utile' = opinion. 'Selon les chiffres, les ventes ont baissé de 8 %' = fact, backed by data. Separating fact from opinion is a core CLB 5 listening skill.",{diff:3}),
     wr("Write 3 signal phrases that introduce a new topic in conversation",["à propos de","en ce qui concerne","d'ailleurs","parlant de","pour ce qui est de","maintenant, parlons de"],"À propos de... / En ce qui concerne... / D'ailleurs,... — Three topic-shift signals used in natural French conversation. Using these appropriately in your own speech signals B1+ competency and makes conversations flow naturally!")]),

  mkL("b1-23","Listening: Radio & News Segment",25,"listening",
    "Understand French radio and news at CLB 5-6 level! Radio-Canada, ICI Radio-Canada Première, RDI, TVA Nouvelles — all essential sources. Strategies for news: 1) First sentences contain the ESSENTIAL information (who, what, when, where). 2) Numbers and proper nouns = priority listening. 3) Quotes from sources (selon le ministre, d'après les experts). 4) Story structure: fact → context → reaction → outlook. Quebec-specific: Journal de Montréal, Le Devoir, La Presse.",
    ["Radio-Canada / ICI Radio-Canada (public broadcaster)","RDI (Radio-Canada info channel)","Les nouvelles du jour (today's news)","Selon le/la ministre... (according to the minister)","D'après les experts (according to experts)","On apprend que... (we learn that)","Il ressort que... (it emerges that)","Le [date], [who] a [what] à [where]","Suite à (following/as a result of)"],
    [mcq("In a news segment, the most important information is usually:",["the last sentence","the reporter's opinion","in the first 1-2 sentences (headline facts)","in the middle of the report"],2,"Lead first! News writing puts the essential W5 (who, what, when, where, why) in the opening sentences. Strategies: listen intensely to the first 20 seconds, then use context for the rest. Even if you miss words, the opening gives you the main story!"),
     li("Il est huit heures, voici les nouvelles. Le gouvernement du Québec a annoncé ce matin un investissement de deux cents millions de dollars dans le transport en commun. Selon la ministre des Transports, les travaux commenceront au printemps prochain.","Combien le gouvernement investit-il, et dans quel domaine?",["200 millions de dollars dans le transport en commun","2 millions dans la santé","200 millions dans les écoles","20 millions dans le logement"],0,"News leads with the essentials. Key facts: « un investissement de deux cents millions de dollars dans le transport en commun ». Numbers and proper nouns are priority listening — catch them in the first sentences.",{once:true,diff:3,transcriptEn:"It's 8 o'clock, here is the news. The Quebec government announced this morning a $200 million investment in public transit. According to the Transport Minister, work will begin next spring."}),
     li("D'après les autorités sanitaires, le nombre de cas de grippe a augmenté de quinze pour cent cette semaine. Les experts recommandent donc la vaccination, surtout pour les personnes âgées de plus de soixante-cinq ans.","Que recommandent les experts?",["La vaccination, surtout pour les personnes âgées","De rester à la maison","De fermer les écoles","Rien de particulier"],0,"« Les experts recommandent la vaccination, surtout pour les personnes âgées. » Notice the source markers — 'd'après les autorités sanitaires', 'les experts recommandent' — they flag where the facts come from.",{once:true,diff:3}),
     wr("Write a 1-sentence news headline about a fictional health initiative",["le gouvernement annonce","une nouvelle mesure","selon le ministre","les autorités de santé","la province de québec"],"Le gouvernement québécois annonce un nouveau programme de vaccination contre la grippe pour les personnes de plus de 65 ans, selon le ministère de la Santé. — Perfect news headline structure: who (government) + what (program) + for whom + source!")]),

  mkL("b1-24","Reading: News Article",25,"reading",
    "Read French newspaper articles at CLB 5-6 level! Quebec newspapers: La Presse, Le Devoir, Journal de Montréal (tabloid), Le Soleil (Quebec City). Structure of news articles: titre (headline), chapeau/sous-titre (lead paragraph — most important), corps (body — supporting details, context, quotes), conclusion. Reading strategies: read title + first paragraph = understand 70% of article. Scan for: numbers, dates, names, and opinion vs fact markers.",
    ["Le titre (headline)","Le chapeau/sous-titre (lead — most important!)","Le corps de l'article (body)","Selon [source] vs 'Il est établi que' (opinion vs fact)","Repérer les chiffres et les noms propres","Inférence contextuelle (guessing from context)","Expressions journalistiques: on apprend que, il ressort, suite à","Citation directe: 'Nous devons agir,' a déclaré..."],
    [mcq("'Le chapeau' of a newspaper article contains:",["the journalist's opinion","the most important facts (W5: who, what, when, where, why)","background and history","expert quotes only"],1,"Le chapeau (lead/intro paragraph) = the most critical part! It answers: qui, quoi, quand, où, pourquoi. If you only read the title + chapeau, you understand the essential news. This is key for CLB 5 reading efficiency!"),
     rd("MONTRÉAL — Le gouvernement du Québec a dévoilé hier un plan de 1,8 milliard de dollars pour construire 8 000 logements abordables d'ici 2027. Selon la ministre de l'Habitation, cette mesure vise à répondre à la crise du logement, qui touche particulièrement les jeunes familles et les nouveaux arrivants. « Nous devons agir rapidement », a déclaré la ministre. Les premières unités devraient être disponibles dès l'automne prochain.","Quel est le but principal de ce plan?",["Construire des logements abordables face à la crise du logement","Augmenter les impôts des familles","Réduire le nombre de nouveaux arrivants","Financer la construction d'écoles"],0,"Read the title + lead (chapeau): the plan funds 8 000 logements abordables to address la crise du logement. Catch the number (1,8 milliard), the timeline (d'ici 2027) and who is affected.",{title:"La Presse — Logement",glossary:[["abordable","affordable"],["l'habitation","housing"],["dès","as early as"]],diff:3}),
     rd("Il serait naïf de croire que la maîtrise du français suffit à elle seule à garantir l'intégration des nouveaux arrivants. Certes, la langue ouvre des portes. Mais sans reconnaissance des diplômes étrangers, de nombreux immigrants qualifiés se retrouvent contraints d'accepter des emplois bien en deçà de leurs compétences. Le véritable enjeu n'est donc pas seulement linguistique : il est aussi économique et institutionnel.","Quelle est la position de l'auteur?",["Le français aide, mais ne suffit pas seul à l'intégration","Le français est inutile pour les immigrants","Les diplômes étrangers sont toujours reconnus au Québec","L'immigration devrait être réduite"],0,"This is inference, not just facts. The author concedes language helps ('Certes, la langue ouvre des portes') but argues the real issue ('le véritable enjeu') is also economic and institutional — credential recognition. Spotting the 'Certes… Mais…' move is key CLB 6 critical reading.",{title:"Le Devoir — Éditorial",glossary:[["en deçà de","below"],["l'enjeu","the issue/stake"],["contraint","forced"]],diff:4}),
     wr("Summarize a 3-sentence article about Quebec French language laws",["la loi","le français","les entreprises doivent","selon le gouvernement","la charte de la langue française"],"Selon un récent article, le gouvernement québécois a renforcé la Charte de la langue française (Loi 101) pour exiger que les entreprises de plus de 25 employés fonctionnent en français. Cette mesure vise à protéger et promouvoir le statut du français au Québec. — Article summary in CLB 5 French!")]),

  mkL("b1-25","Reading: Official Canadian Document",25,"reading",
    "Read official Canadian documents — immigration letters, tax notices, employment contracts, government forms! Key vocabulary: attendu que (whereas), conformément à (in accordance with), en vertu de (by virtue of/under), sous réserve de (subject to), à titre de (as/in the capacity of), ci-dessus/ci-dessous (above/below mentioned), susmentionné (aforementioned), ledit/ladite (the said), le cas échéant (if applicable), s'il y a lieu (where applicable).",
    ["conformément à (in accordance with)","en vertu de (by virtue of/under)","sous réserve de (subject to)","attendu que (whereas — preamble language)","ci-dessus/ci-dessous (above/below mentioned)","le présent document (this document)","à compter du [date] (effective/starting [date])","le cas échéant (if applicable)","veuillez noter que (please note that)","toute fausse déclaration (any false declaration)"],
    [mcq("'Conformément à l'article 15 de la loi' means:",["contrary to article 15","approximately per article 15","in accordance with article 15 of the law","before article 15 of the law"],2,"Conformément à = in accordance with. Very common in legal and official documents. 'Conformément à la loi sur la protection des renseignements personnels, vos données sont protégées.' You'll see this on every Canadian privacy notice!"),
     rd("Objet : Décision relative à votre demande de résidence permanente\n\nMadame, Monsieur,\n\nNous accusons réception de votre demande. Conformément à l'article 12 du Règlement, votre dossier a été examiné. Sous réserve de la vérification de vos antécédents, votre demande est acceptée. Vous devez vous présenter à nos bureaux, muni d'une pièce d'identité, à compter du 1er mars. Veuillez noter que toute fausse déclaration entraînera le rejet de votre demande.","D'après la lettre, à quelle condition la demande est-elle acceptée?",["Sous réserve de la vérification des antécédents","Sans aucune condition","Après le paiement d'une amende","Uniquement si la personne parle français"],0,"« Sous réserve de la vérification de vos antécédents » = subject to a background check. 'Sous réserve de' signals a condition. Also note 'à compter du 1er mars' (effective March 1) and the warning about 'toute fausse déclaration'.",{title:"Lettre officielle — IRCC",glossary:[["conformément à","in accordance with"],["sous réserve de","subject to"],["muni de","carrying / equipped with"],["à compter du","effective from"]],diff:4}),
     rd("AVIS D'AUGMENTATION DE LOYER\n\nConformément à la loi, nous vous informons que, à compter du 1er juillet, votre loyer mensuel passera de 1 150 $ à 1 196 $, soit une augmentation de 4 %. Le cas échéant, vous disposez d'un délai d'un mois pour refuser cette augmentation par écrit. Sans réponse de votre part, l'augmentation sera réputée acceptée.","Que se passe-t-il si le locataire ne répond pas?",["L'augmentation est considérée comme acceptée","Le bail est annulé","Le loyer reste à 1 150 $","Le locataire doit déménager"],0,"« Sans réponse de votre part, l'augmentation sera réputée acceptée » = if you don't reply, the increase is deemed accepted. 'Le cas échéant' (if applicable) flags the option to refuse in writing within one month.",{title:"Avis de loyer — Régie du logement",glossary:[["le cas échéant","if applicable"],["un délai","a time limit"],["réputé","deemed"]],diff:4}),
     wr("Explain what 'à compter du 1er mars, les tarifs seront modifiés' means",["à partir du 1er mars","les tarifs vont changer","les prix changent le 1er mars","à compter du signifie"],"À compter du 1er mars = starting/effective March 1st. The rates will be changed/modified. 'À compter de' is official document language for 'starting from this date.' You'll see it on utility bills, government notices, and rent increase letters!")]),

  mkL("b1-26","B1 Grammar Review: All Tenses",30,"integrated",
    "Complete B1 tense review! You now have: présent (current habits/facts), passé composé (specific completed past), imparfait (past description/habits), plus-que-parfait (before another past), futur proche (imminent plan), futur simple (formal/distant future), futur antérieur (before another future), conditionnel présent (would/polite/hypothetical), conditionnel passé (would have — regrets), subjonctif présent (after triggers — doubt/emotion/necessity), gérondif (en + -ant). That's 11 tenses/moods — you're at B1!",
    ["Révision: présent, PC, IMP, PQP","Révision: futur proche, futur simple, futur antérieur","Révision: conditionnel présent et passé","Révision: subjonctif présent (principaux déclencheurs)","Révision: gérondif (en + -ant)","Combinaisons: Si + IMP + conditionnel / Si + PQP + cond. passé","Concordance des temps en discours indirect","Voix passive à tous les temps"],
    [mcq("Complete: 'Si j'___ (avoir) su, je n'___ (venir) pas.' (Type 3 — past regret)",["avais / viendrais","avais eu / serais venu","aurais / venais","avais / serai venu"],1,"Si + plus-que-parfait (avais eu = had known... wait: 'si j'avais su' - savoir) → conditionnel passé (je ne serais pas venu). Type 3: si + PQP + conditionnel passé = past regret/impossible hypothesis. 'Si j'avais su, je ne serais pas venu' = If I had known, I wouldn't have come."),
     mcq("'Il faut que vous ___ (lire) ce document.' — Subjunctive?",["lisez","lisiez","lire","lirez"],1,"Lisiez = subjunctif présent of lire. Lire → ils lisent → lis- → vous lisiez. 'Il faut que' ALWAYS triggers subjunctive! 'Il faut que vous lisiez ce document avant la réunion.'"),
     wr("Write a sentence using the futur antérieur correctly",["dès que j'aurai","quand tu auras","lorsque nous aurons","aussitôt qu'elle sera","une fois que vous aurez"],"Dès que j'aurai obtenu ma citoyenneté, je voterai aux prochaines élections. — Futur antérieur (aurai obtenu) for the action completed FIRST + futur simple (voterai) for what happens after. Perfect B1 temporal sequence!")]),

  mkL("b1-27","B1 Grammar Review: Pronouns & Clauses",25,"integrated",
    "Final pronoun mastery at B1! All pronouns: subject (je/tu/il...), direct object (le/la/les), indirect (lui/leur), reflexive (me/te/se/nous/vous), y, en, stressed pronouns (moi/toi/lui/elle/nous/vous/eux/elles), relative (qui/que/dont/où/lequel). Stressed pronouns used after prepositions (pour moi, avec lui), for emphasis (moi, je pense que...), and after c'est (c'est moi qui...). Multiple pronoun order: me/te/se/nous/vous → le/la/les → lui/leur → y → en.",
    ["pronoms toniques: moi, toi, lui, elle, nous, vous, eux, elles","après préposition: je pense à lui (not 'à il'!)","emphase: moi, je travaille dur","c'est lui qui... (it's he who...)","ordre des pronoms multiples","y et en avec quantités","qui/que/dont/où/lequel — tous les relatifs","accord du participe avec pronom COD"],
    [mcq("'Cette décision appartient à eux.' — Can we use a pronoun?",["Elle leur appartient","Il leur appartient","Elle appartient à eux","Elle y appartient"],0,"Elle leur appartient — appartenir à + PERSON → indirect pronoun (leur). 'Eux' is stressed pronoun (used after prepositions), but with appartenir à + person, we use lui/leur. 'Cette décision leur appartient.' (feminine: la décision → elle)"),
     mcq("'C'est ___ qui a pris la décision.' (emphasizing: it was HE who)",["lui","il","le","y"],0,"C'est lui qui — after 'c'est', use stressed pronouns: moi, toi, lui, elle, nous, vous, eux, elles. 'C'est lui qui a pris la décision' = It was HE who made the decision (emphasis). Contrast: 'Il a pris la décision' (no emphasis)."),
     wr("Combine with a relative clause: 'J'ai un collègue. Je lui parle souvent. Il est très compétent.'",["j'ai un collègue dont je parle souvent et qui est très compétent","j'ai un collègue à qui je parle souvent et qui est très compétent"],"J'ai un collègue à qui je parle souvent et qui est très compétent — à qui (indirect: parler à + person) + qui (subject relative). Both relative clauses connected by 'et'. Advanced B1 sentence combining 2 relative clauses!")]),

  mkL("b1-28","CLB 5 Speaking Simulation",30,"speaking",
    "Full CLB 5 speaking simulation! CLB 5 speaking tasks: 1) 1-minute self-introduction with professional background. 2) Describe a past experience (2 min — using PC and IMP). 3) Give an opinion on a general topic (2 min — structured monologue). 4) Role-play a service interaction (2 min). Assessment criteria: comprehensibility, fluency, vocabulary range, grammatical accuracy, pronunciation. Tip: assessors overlook occasional errors — they care about communication!",
    ["Tâche 1: présentation de 1 minute","Tâche 2: expérience passée (2 min)","Tâche 3: opinion structurée (2 min)","Tâche 4: jeu de rôle - service (2 min)","Critères: compréhensibilité, aisance, vocabulaire","Stratégie: ne pas paniquer après une erreur","Connecteurs avancés tout au long","Exemples précis et canadiens","Gérer les pauses: 'Laissez-moi réfléchir...' ou 'En d'autres termes...'"],
    [mcq("If you make a grammar error during a CLB speaking assessment, you should:",["stop and start over","become silent and wait","correct yourself briefly and continue speaking","apologize extensively"],2,"Correct briefly and keep going! 'J'ai... je voulais dire j'ai ÉTUDIÉ.' Quick self-correction shows metalinguistic awareness (a good sign!). Then continue. Long pauses or excessive apologies hurt your score more than an error does!"),
     mcq("CLB 5 speaking requires approximately how long an opinion monologue?",["10-15 seconds","30-45 seconds","1.5-2 minutes","5 minutes"],2,"1.5-2 minutes = CLB 5 opinion monologue. Structure in: intro (20s) + argument 1 (30s) + argument 2 (30s) + conclusion (20s) = ~100 seconds. Practice with a timer! CLB 6 = 3 minutes with concession."),
     wr("Write your 3-sentence introduction for the CLB 5 speaking test",["je m'appelle","je viens de","j'ai de l'expérience","je suis actuellement","j'apprends le français depuis"],"Je m'appelle [Name], je suis originaire de [country] et j'habite à [city] depuis [X] ans. J'ai [X] ans d'expérience dans le domaine de [field] et je suis actuellement [situation]. J'apprends le français depuis [X] mois/ans car je veux [goal]. — Perfect CLB 5 intro: complete, fluent, professional!")]),

  mkL("b1-29","CLB 5 Writing Simulation",30,"writing",
    "Full CLB 5 writing simulation! CLB 5 tasks: 1) Fill a detailed form. 2) Write a functional message (email/note — 60-80 words). 3) Write an opinion paragraph (80-120 words). Assessment criteria: task completion, vocabulary range, grammatical control, organization, spelling. Checklist before submitting: ✓ Did I answer ALL parts of the prompt? ✓ Is the register correct (formal/informal)? ✓ Did I use vous (formal) vs tu (informal) correctly? ✓ Are my verb tenses correct? ✓ Did I spell-check?",
    ["Tâche 1: formulaire détaillé","Tâche 2: message fonctionnel (60-80 mots)","Tâche 3: paragraphe d'opinion (80-120 mots)","Critères: complétion, vocabulaire, grammaire, organisation","Registre: formel vs informel (vous vs tu)","Vérification: tous les éléments demandés?","Orthographe et ponctuation","Connecteurs logiques dans le paragraphe d'opinion","Structures variées (pas la même phrase répétée)"],
    [mcq("In CLB 5 writing, which is most heavily penalized?",["1-2 minor spelling errors","not completing all parts of the task","using informal language once","a repeated grammar error that doesn't affect meaning"],1,"Not completing ALL parts of the task = most heavily penalized in CLB writing! Assessors use a checklist. If the task says 'explain why + describe how', you must address BOTH. A perfectly written text that misses part of the task fails!"),
     mcq("A CLB 5 opinion paragraph of 80-120 words should have:",["only an opinion with no justification","one opinion sentence","introduction + 2 justified arguments + conclusion","a list of arguments without connection"],2,"Introduction + 2 justified arguments + conclusion = minimum structure for 80-120 words. Each argument needs 'parce que' or 'car' + example. No bullet points in essays! Continuous flowing prose with connectors."),
     wr("Write a 60-word formal email declining a meeting invitation",["je vous remercie de votre invitation","malheureusement","je ne serai pas disponible","je vous propose une autre date","cordialement"],"Bonjour Madame/Monsieur, Je vous remercie de votre invitation pour la réunion du [date]. Malheureusement, je ne serai pas disponible ce jour-là en raison d'un engagement préalable. Je vous propose de nous rencontrer la semaine suivante, si cela vous convient. Dans l'attente de votre réponse. Cordialement, [Nom]. — Exactly 60 words, CLB 5 formal email!")]),

  mkL("b1-30","CLB 5 Listening Practice",25,"listening",
    "CLB 5 listening includes: voicemail messages (extract key info), announcements (understand instructions), conversations (identify speaker positions), short lectures/explanations (follow main points). Strategies: 1) Read questions BEFORE listening. 2) Focus on keywords, numbers, names. 3) Don't panic at unknown words — use context. 4) Write notes during listening. 5) Check notes immediately after. Quebec accent tip: 'tu' sounds like 'tsu', 'di'→'dzi', short vowels. Practice with Radio-Canada!",
    ["Écouter Radio-Canada pour s'habituer à l'accent québécois","'Tu' → 'tsu', 'di' → 'dzi' (accent québécois)","Lire les questions AVANT d'écouter","Focus: noms, chiffres, dates = priorité","Prendre des notes pendant l'écoute","Utiliser le contexte pour les mots inconnus","CLB 5: extraire info spécifique d'un dialogue 3-5 min","Repérer les opinions vs faits"],
    [mcq("The Quebec French pronunciation of 'tu es' sounds like:",["too ay","tsu ay","tu es","tyu ez"],1,"'Tu' in Quebec French = 'tsu' (affrication of T before U). 'Tu es' = 'tsu-ay'. Similarly: 'ti' = 'tsi', 'di' = 'dzi'. This is a distinctive Quebec feature — not an error! Understanding it helps you follow natural Quebec conversations and Radio-Canada!"),
     li("Bonjour, vous êtes bien sur la boîte vocale de la clinique Saint-Laurent. Votre rendez-vous avec le docteur Tremblay est confirmé pour mardi le 14 à quatorze heures trente. Veuillez arriver quinze minutes à l'avance avec votre carte d'assurance maladie. Pour annuler, composez le 514 555 0182.","Quand est le rendez-vous, et que faut-il apporter?",["Mardi 14 à 14 h 30, avec la carte d'assurance maladie","Lundi 14 à 4 h, avec une pièce d'identité","Mardi 4 à 14 h, sans rien apporter","Mercredi 14 à 14 h 30, avec de l'argent"],0,"Voicemail = extract key info. Date/time: « mardi le 14 à quatorze heures trente » (14:30). Bring: « votre carte d'assurance maladie », and arrive 15 minutes early. Listen hard for numbers — they're the priority.",{diff:3,transcriptEn:"Hello, you've reached the voicemail of the Saint-Laurent clinic. Your appointment with Dr. Tremblay is confirmed for Tuesday the 14th at 2:30 p.m. Please arrive 15 minutes early with your health insurance card. To cancel, dial 514 555 0182."}),
     wr("Write 3 things you'll listen for in a CLB listening passage about an apartment",["le loyer","le nombre de chambres","la localisation","les charges","la disponibilité","les conditions"],"Les 3 éléments clés: 1) Le loyer mensuel (rent amount), 2) Les caractéristiques (nombre de chambres, inclus ou non), 3) La disponibilité et les conditions (when available, requirements). Reading the question about apartments first tells you to listen for these specific details!")]),

  mkL("b1-31","CLB 5 Reading Practice",25,"reading",
    "CLB 5 reading includes: reading for specific information (scanning), reading for general understanding (skimming), reading to infer (reading between the lines). Text types: notices, short articles, emails, advertisements, schedules. Strategies: 1) Skim the whole text first (30 sec). 2) Read questions. 3) Return to text for specific answers. 4) For inference questions: use context + logic, not stated directly. Key CLB 5 vocabulary in texts: municipal notices, workplace emails, school communications, health instructions.",
    ["Survol (skimming) = vue générale rapide","Lecture sélective (scanning) = trouver info spécifique","Inférence = lire entre les lignes","Vocabulaire: avis, règlement, politique, conformément","Type de texte détermine la stratégie","Questions d'inférence: 'on peut en déduire que'","Questions factuelles: retourner au texte précisément","Temps de lecture: gérer efficacement"],
    [mcq("'On peut en déduire que...' in a CLB reading question means:",["find the exact quote from the text","infer from the text (not directly stated)","calculate a number from the text","find the opinion of the author"],1,"'On peut en déduire que' = inference question! The answer is NOT directly stated — you must use logic and context. 'The text doesn't say this directly, but based on the information given, we can logically conclude that...' These are the hardest CLB reading questions!"),
     rd("AVIS AUX RÉSIDENTS\n\nLa Ville de Montréal informe les résidents que la collecte des ordures ménagères sera déplacée du lundi au mercredi pendant la semaine du 8 juillet, en raison du congé férié. Le bac de recyclage doit être déposé en bordure de rue avant 7 h. Les bacs laissés sur le trottoir après la collecte feront l'objet d'un avertissement.","D'après l'avis, que doivent faire les résidents la semaine du 8 juillet?",["Sortir les bacs le mercredi avant 7 h","Sortir les ordures le lundi comme d'habitude","Apporter les ordures à la déchetterie","Payer des frais supplémentaires"],0,"Scan for the change: collection moves « du lundi au mercredi » that week because of the holiday, and bins must be out « avant 7 h ». Skim first, then find the specific detail the question asks for.",{title:"Avis municipal — Ville de Montréal",glossary:[["les ordures ménagères","household waste"],["en bordure de rue","at the curb"],["un congé férié","a public holiday"]],diff:3}),
     wr("What does 'Les frais de dossier sont non remboursables' mean in a form?",["the file fees are refundable","the file fees are not refundable","there are no file fees","you must pay refundable fees"],"Les frais de dossier sont non remboursables = the file/processing fees are non-refundable. 'Non remboursables' = not refundable. Critical information! Don't submit an incomplete application if you might want your money back. This phrase appears on immigration, professional licensing, and school application fees!")]),

  mkL("b1-32","B1 Integrated Practice 1",30,"integrated",
    "Integrated B1 practice — real-world scenario combining all 4 skills! Scenario: You're preparing for a job interview at a Quebec company. You: 1) Read the job posting (reading), 2) Research the company and prepare questions (reading + writing), 3) Email your application (writing), 4) Listen to the interview invitation voicemail (listening), 5) Practice interview responses (speaking). This mirrors the real CLB 6 test format!",
    ["Offre d'emploi: identifier les exigences clés","Lettre de motivation: 3 paragraphes (vous, l'entreprise, l'adéquation)","Courriel de candidature: formel, complet","Message de confirmation d'entrevue","Préparation aux questions d'entrevue","Décrire ses compétences avec des exemples concrets","Poser des questions professionnelles à la fin"],
    [mcq("A 'lettre de motivation' (cover letter) should:",["repeat everything in your CV","explain why you're the best fit for this specific role + company","be as long as possible","focus only on your weaknesses"],1,"La lettre de motivation = why you + why this company + why this role. 3 paragraphs: 1) Who you are + what you're applying for. 2) Your relevant skills/experience for THIS role. 3) Why THIS company + what you'll bring. Never just summarize your CV!"),
     mcq("'Je pose ma candidature pour le poste de...' opens a cover letter. This means:",["I am resigning from the position of...","I am applying for the position of...","I am recommending someone for the position of...","I am declining the position of..."],1,"Poser sa candidature (pour) = to apply (for a position). 'Je pose ma candidature pour le poste de [title] annoncé sur [platform].' Standard cover letter opening. Also: 'Je me permets de vous soumettre ma candidature pour...' (slightly more formal)."),
     wr("Write the second paragraph of a cover letter highlighting your key skill",["fort de mon expérience","ayant travaillé","grâce à mes compétences","je possède","j'ai développé"],"Fort de mon expérience de [X] ans dans le domaine de [field], j'ai développé des compétences solides en [skill 1] et en [skill 2]. Par exemple, dans mon précédent poste, j'ai [specific achievement], ce qui a conduit à [positive result]. — STAR method embedded in a CLB 5 cover letter paragraph!")]),

  mkL("b1-33","B1 Integrated Practice 2",25,"integrated",
    "Second integrated B1 practice — civic engagement scenario! You: 1) Read a notice about a public consultation in your municipality (reading), 2) Listen to a radio segment about the issue (listening), 3) Write a brief opinion to the municipality (writing — 100 words), 4) Practice speaking your opinion clearly (speaking — 2 min). Topic: proposed construction of a new community centre. This type of civic participation is valued and common in Canadian communities.",
    ["Avis de consultation publique (public consultation notice)","Comprendre les enjeux locaux (local issues)","Lettre à la municipalité (letter to city)","Opinion sur un projet de construction","Exprimer accord/désaccord avec justification","Proposer des solutions alternatives","Vocabulaire: consultation, résidents, enjeux, aménagement","Participation citoyenne = compétence CLB 6"],
    [mcq("A public consultation (consultation publique) allows:",["only elected officials to speak","only property owners to comment","any resident to express opinions on municipal projects","companies only to present plans"],2,"Any resident can participate in public consultations in Canada! This is part of civic engagement and democratic process. You can: attend in person, write a letter, submit online comments. Newcomers are ENCOURAGED to participate — your perspective matters!"),
     mcq("'Les enjeux' of a project refers to:",["the project costs only","the stakes/issues at play","the project timeline","the project manager"],1,"Les enjeux = the stakes/issues at play — what's important about this project, what could be gained or lost. 'Les enjeux de ce projet incluent l'impact sur le trafic, le bruit, et l'accès aux services.' Very common in Quebec civic and political discourse!"),
     wr("Write your opinion on a new community centre for your neighbourhood",["à mon avis, ce projet","selon moi, il serait bénéfique","je suis favorable à","je soutiens ce projet","cependant, je m'inquiète de"],"À mon avis, la construction d'un centre communautaire serait très bénéfique pour notre quartier, car il offrirait des espaces de rencontre et des activités pour tous les âges. Cependant, il serait important de minimiser l'impact sur la circulation et le stationnement. En conclusion, je soutiens ce projet sous réserve d'une planification adéquate. — Structured 100-word opinion!")]),

  mkL("b1-34","B1 Assessment Prep",25,"integrated",
    "Final B1 preparation before the assessment! Checklist of everything you should now be able to do: ✓ Use 8+ tenses correctly in context ✓ Employ complex pronouns and relative clauses ✓ Write formal emails and letters ✓ Deliver 2-minute structured opinion ✓ Understand extended conversations ✓ Read official documents and news ✓ Discuss work, civic life, and current affairs in French. What to review if still unsure: subjunctive triggers, futur antérieur, pronoun order, essay structure.",
    ["Bilan B1 complet: 8+ temps verbaux","Réviser: subjonctif (déclencheurs)","Réviser: futur antérieur (dès que + FA)","Réviser: ordre des pronoms multiples","Structure de l'essai d'opinion","Stratégies de lecture et d'écoute CLB","Vocabulaire thématique: travail, civisme, environnement","Vous êtes prêt(e) pour le niveau B2!"],
    [mcq("The subjunctive is triggered by all EXCEPT:",["il faut que","je suis content que","bien que","après que"],3,"Après que = indicatif (NOT subjunctive)! Avant que → subjunctive; après que → indicative. This is the trickiest subjunctive rule. 'Après qu'il est parti' (indicative), 'Avant qu'il parte' (subjunctive). Don't confuse them!"),
     mcq("Futur antérieur is REQUIRED after:",["si + present","d'habitude","dès que / quand (future sequence)","parce que"],2,"After 'dès que, quand, lorsque, aussitôt que' when both verbs are future: first action = futur antérieur, second = futur simple. 'Dès que tu AURAS FINI, nous PARTIRONS.' A key B1 grammar test point!"),
     wr("Name 3 topics you can discuss in French at B1 level",["le travail","l'environnement","la santé","le logement","l'immigration","la politique","la technologie","l'éducation"],"Je peux discuter de: 1) Le marché du travail et les droits des employés au Canada, 2) L'environnement et les politiques climatiques au Québec, 3) Le système de santé canadien et les services aux immigrants. — At B1 you can discuss ANY real-world topic with justification and nuance!")]),

  mkL("b1-35","B1 Final Assessment",35,"integrated",
    "B1 FINAL ASSESSMENT — comprehensive evaluation of all B1 skills! This final assessment confirms CLB 5-6 readiness. You will demonstrate: reading a complex document, writing a formal opinion letter (120 words), understanding an extended listening passage, and speaking on a workplace topic for 2 minutes. If you pass this, you're ready for B2 and targeting CLB 7! Félicitations — vous avez atteint le niveau B1/CLB 5!",
    ["Évaluation finale B1 — 4 compétences","Lecture: document officiel avec inférences","Écriture: lettre d'opinion formelle (120 mots)","Écoute: dialogue étendu (5 min)","Expression orale: monologue structuré (2 min)","CLB 5 confirmé → passez au B2!"],
    [mcq("'Il va sans dire que' means:",["he is going without saying","it goes without saying that","it should be said that","he goes without saying"],1,"Il va sans dire que = it goes without saying that. Used to introduce an obvious point with emphasis. 'Il va sans dire que la maîtrise du français est un atout majeur sur le marché du travail canadien.' Sophisticated B1-B2 expression!"),
     mcq("A formal opinion letter that is most likely to succeed:",["only states your opinion without reasons","is very emotional and personal","gives a clear position + 2 justified arguments + concrete example + courteous request","is as long as possible"],2,"Clear position + 2 justified arguments + concrete example + courteous request = successful formal opinion letter. The CONTENT must be logical, the TONE must be respectful, the REGISTER must be formal throughout!"),
     wr("Write your 2-sentence B1 certification statement",["j'ai atteint le niveau b1","je suis maintenant capable de","je peux communiquer","j'ai complété","je suis prêt pour le b2"],"J'ai complété le niveau B1 du programme Franco et je suis maintenant capable de communiquer efficacement en français dans des contextes professionnels et civiques au Canada. Je me prépare maintenant pour le niveau B2 et l'examen TEF Canada. — Félicitations! Vous avez réussi le niveau B1/CLB 5!")]),

  mkL("b1-36","B1 → B2 Bridge: Advanced Structures Preview",25,"integrated",
    "Transition from B1 to B2 — preview of what's coming! B2 introduces: full subjunctive mastery (all triggers including concessive), passive voice in all tenses, nominalization (turning verbs into nouns: étudier → l'étude), complex connectors (nonobstant, force est de constater, il convient de), register control (formal vs informal vs literary), and TEF Canada-level performance. Your B1 skills are the foundation — B2 is about NUANCE, not new grammar.",
    ["B2 = nuance, pas nouvelles règles fondamentales","Subjonctif complet (bien que, quoique, à condition que)","Voix passive dans tous les temps","Nominalisation: étudier → l'étude","Connecteurs sophistiqués: nonobstant, certes, il convient de","Contrôle du registre (formel/familier/littéraire)","TEF Canada: expression écrite et orale avancées","Vocabulaire: 3000 mots actifs pour B2"],
    [mcq("The key difference between B1 and B2 is:",["learning completely new grammar rules","refining nuance, register, and sophistication in using existing structures","switching from French to English","learning different vocabulary"],1,"B2 = same grammar foundations but with NUANCE. More precise vocabulary, better register control, more sophisticated connectors, longer sustained productions. The grammar you know — you just need to deploy it with more precision and elegance!"),
     mcq("'Nonobstant' is a B2 connector that means:",["therefore","furthermore","notwithstanding/despite","in conclusion"],2,"Nonobstant = notwithstanding/despite (very formal/legal French). 'Nonobstant les difficultés rencontrées, le projet a été mené à terme.' Used in legal documents, formal reports, and B2+ writing. It's a register marker — using it signals advanced French proficiency!"),
     wr("Transform into a nominal phrase: 'Les étudiants apprennent le français.' → 'L'___ du français...'",["l'apprentissage du français par les étudiants","l'apprentissage du français"],"L'apprentissage du français — apprendre → l'apprentissage. Nominalization = turning a verb into a noun. Common patterns: -er verbs → -(a/e/i)tion, -ment, or noun form. 'Travailler → le travail', 'décider → la décision', 'apprendre → l'apprentissage'. Key B2 writing feature!")]),

  mkL("b1-37","CLB 6 Writing: Opinion Letter",30,"writing",
    "CLB 6 writing: a formal opinion letter (120-150 words) to an organization! This is harder than CLB 5 because: more words required, more complex argument structure, concession expected, sophisticated vocabulary and connectors. Topic example: writing to your child's school about adding more French cultural activities. Structure: introduction + argument 1 + argument 2 + concession + recommendation + closing.",
    ["CLB 6: 120-150 mots en production écrite","Structure complète avec concession","Vocabulaire sophistiqué et varié","Connecteurs avancés: de surcroît, par ailleurs, force est de constater","Formule d'appel et de clôture formelles","Une recommandation concrète","Sans erreurs de temps verbaux","Registre formel maintenu tout au long"],
    [mcq("'De surcroît' is a CLB 6+ connector that means:",["on the contrary","moreover/furthermore (emphatic)","in conclusion","despite"],1,"De surcroît = moreover/furthermore (more emphatic than 'de plus'). 'Cette décision est coûteuse. De surcroît, elle risque de mécontenter les résidents.' Shows sophisticated argumentation. Other advanced connectors: par ailleurs, qui plus est, force est de constater."),
     mcq("A CLB 6 formal letter should NOT contain:",["vous-form throughout","sophisticated connectors","slang or informal expressions","a clear recommendation"],2,"No slang or informal language in CLB 6 formal writing! 'C'est pas juste' → 'Il est injuste que...'. 'Je trouve ça bizarre' → 'Je juge cette décision discutable.' Register control = using the right language for the context. CLB 6 = consistently formal!"),
     wr("Write a concession sentence for your opinion letter",["certes, il est vrai que","je comprends que","il convient de reconnaître que","bien que","je n'ignore pas que"],"Certes, il convient de reconnaître que la mise en place de telles activités représente un investissement en temps et en ressources pour l'établissement. Néanmoins, les bénéfices à long terme pour les élèves et leur intégration culturelle justifient amplement cet effort. — Perfect B1-B2 concession + counter-argument!")]),

  mkL("b1-38","CLB 6 Speaking: Extended Interaction",25,"speaking",
    "CLB 6 speaking: extended interaction (conversation + opinion defence + role-play). CLB 6 adds to CLB 5: you can defend your position when challenged, ask for clarification politely, maintain conversation for longer, use a wider vocabulary range, and show awareness of register (adjusting formality). Key phrases for defending position: 'Je maintiens que...' (I maintain that), 'Mon argument tient toujours parce que...' (My argument still stands because), 'Je comprends votre point mais il reste que...' (I understand your point but it remains that...).",
    ["Je maintiens que... (I maintain that)","Mon argument tient toujours parce que...","Il reste que... (it remains that)","Permettez-moi d'insister sur le fait que... (let me insist on the fact that)","C'est précisément pour cette raison que... (that's exactly why)","En toute franchise (frankly)","Il n'en demeure pas moins que (it doesn't change the fact that)","Gérer les interruptions poliment"],
    [mcq("'Je maintiens ma position' shows that you are:",["changing your mind","asking for clarification","defending and holding your original position","agreeing with the other person"],2,"Je maintiens ma position / je maintiens que... = I'm standing by/defending my position. Used when someone challenges your argument. 'Je comprends votre point, néanmoins je maintiens que l'apprentissage du français est indispensable.' Shows confidence and argumentative skill!"),
     mcq("'Il n'en demeure pas moins que' means:",["nevertheless / it remains true that","despite everything, it's not true that","I agree with everything","therefore"],0,"Il n'en demeure pas moins que = nevertheless / it remains true that. A sophisticated connector used to maintain your argument after acknowledging another point. 'Certes, la situation est complexe. Il n'en demeure pas moins que des mesures s'imposent.' Very CLB 6-7!"),
     wr("Defend this position when challenged: 'Le français est essentiel au Québec'",["je maintiens que","mon argument tient","il reste que","il n'en demeure pas moins que","c'est précisément pour cette raison"],"Je maintiens que le français est essentiel au Québec, car c'est la seule langue officielle de la province et le vecteur de toute une culture vivante. Il n'en demeure pas moins que sans le français, l'intégration professionnelle et sociale reste très limitée. — Strong position defence!")]),

  mkL("b1-39","B1 Vocabulary: 1000 Key Words Review",25,"integrated",
    "Vocabulary consolidation at B1 level! A solid B1 speaker controls approximately 2000-3000 words actively and recognizes 5000+ passively. This review focuses on the 1000 most important B1 words across themes: professional life, health, housing, transport, civic life, environment, education, technology, family, culture. Plus: 50 essential Quebec-specific words that make you sound local!",
    ["Mots-clés: professionnel, santé, logement, transport","Vocabulaire civic: droits, devoirs, élections, lois","Environnement: changement climatique, énergie, déchets","Technologie: données, cybersécurité, télétravail","50 mots québécois incontournables!","Char (= voiture), Magasinage (= shopping)","Dépanneur (= convenience store)","Tuque (= winter hat), Poudrerie (= blowing snow)","Pantoufles (slippers), Botte (boot), Mitaines (mittens)"],
    [mcq("In Quebec French, 'le char' means:",["a chariot","a train car","a car/automobile","a shopping cart"],2,"Le char = car/automobile (informal Quebec French). Standard French = la voiture. You'll hear 'char' constantly in everyday Quebec speech! Other Quebec vocab: le magasinage (shopping), le dépanneur (corner store/depanneur), la tuque (winter hat/toque)."),
     mcq("'Le dépanneur' in Quebec is:",["a tow truck","a convenience store","a repairman","a police officer"],1,"Le dépanneur = convenience store (corner store). Open late, sells groceries, cigarettes, lottery tickets, and sometimes beer (in Quebec). 'Je vais au dépanneur acheter du lait.' Essential Quebec cultural vocabulary!"),
     wr("Write 3 Quebec-specific words you've learned and their standard French equivalents",["char = voiture","magasinage = shopping","tuque = bonnet","dépanneur = épicerie de quartier","poudrerie = neige soufflée","mitaines = moufles"],"Char (auto/voiture), tuque (bonnet/chapeau d'hiver), dépanneur (épicerie de quartier). Knowing Quebec vocabulary marks you as culturally aware and makes you more relatable to local Quebecers. Language is always tied to culture!")]),

  mkL("b1-40","CLB 5 Certification Ready Check",30,"integrated",
    "FINAL B1 CHECK — are you CLB 5 certified ready? This lesson is your comprehensive self-assessment across all 4 CLB 5 skills. After completing this: if you can do everything here comfortably, you're ready to take the TEF Canada test targeting CLB 5+! Your next step: B2 for CLB 7-8 and full TEF Canada preparation. Bon courage — vous avez accompli quelque chose d'extraordinaire!",
    ["✓ Compréhension orale: dialogues étendus (5 min)","✓ Expression orale: monologue 2 min + interaction","✓ Compréhension écrite: articles, avis, documents officiels","✓ Expression écrite: lettre formelle 120 mots","✓ Grammaire: 8+ temps correctement utilisés","✓ Vocabulaire: 2000+ mots actifs","✓ Registre: formel maintenu en contexte professionnel","Prochaine étape: B2 → CLB 7 → TEF Canada"],
    [mcq("CLB 5 in all 4 skills means you can:",["only handle very basic everyday tasks","communicate in routine situations without preparation","handle complex professional and academic situations","function as a native French speaker"],1,"CLB 5 = independent user. You can handle routine tasks without preparation, discuss familiar topics, read and write short functional texts. NOT yet fluent for all professional contexts — that's CLB 7+. CLB 5 is a major milestone for immigration and many jobs!"),
     mcq("The TEF Canada test assesses your French for:",["school admission in France","Canadian immigration, citizenship, and professional recognition","tourism to Quebec","French cultural knowledge"],1,"TEF Canada = official French test for immigration to Canada (Express Entry, citizenship, provincial programs). Administered by CCFL. Your score maps to CLB/NCLC levels. Results valid 2 years. Many immigration programs require CLB 7 minimum!"),
     wr("Write your commitment to continue to B2",["je m'engage à continuer","je vais poursuivre","mon prochain objectif","je vise le clb","je continuerai à étudier"],"Je m'engage à poursuivre mon apprentissage jusqu'au niveau B2/CLB 7, afin de réussir l'examen TEF Canada et d'atteindre mes objectifs d'immigration et d'intégration professionnelle au Canada. Je continuerai à pratiquer les 4 compétences chaque jour. — Commitment statement: you've earned B1. Now go get B2!")])

];

// ─────────────────────────────────────────────────────────────────────────────
// B2 — 30 LESSONS
// ─────────────────────────────────────────────────────────────────────────────
const B2_LESSONS = [
  mkL("b2-01","Subjunctive: Advanced Uses",35,"writing",
    "Full subjunctive mastery for B2/CLB 7! All triggers: doubt (douter que, ne pas croire que), emotion (être content que, regretter que, avoir peur que), necessity (il faut que, il est essentiel que), concession (bien que, quoique, sans que), purpose (pour que, afin que), condition (à condition que, pourvu que, à moins que). Plus: sequence triggers avant que vs après que (indicative!).",
    ["douter que + subj","être content que + subj","bien que / quoique + subj","pour que / afin que + subj","à condition que + subj","avant que + subj","après que + indicatif (not subjunctive!)","subjonctif passé: qu'il ait parlé"],
    [mcq("'Je suis content ___ tu sois là.' Correct because:",["'content' is an adjective","'être content que' triggers subjunctive","'là' is a location","the sentence is positive"],1,"Emotion verbs/adjectives trigger subjunctive: être content que, être triste que, regretter que, avoir peur que. 'Je suis content que tu sois là' = I'm glad you're here. Subjunctive after emotion!"),
     mcq("'Après qu'il ___ (partir), nous avons mangé.' Correct form:",["soit parti","aille","parte","est parti"],3,"After 'après que' = INDICATIVE (not subjunctive!). 'Après qu'il est parti' = after he left. This is a common B2 error: avant que → subjunctive, APRÈS QUE → indicative!"),
     wr("Write a sentence using 'pour que' + subjunctive",["pour que je","pour que tu","pour que nous","pour qu'il","pour qu'elle","pour qu'ils"],"Pour que j'apprenne le français, je pratique tous les jours. — pour que + subjunctive. 'Pour que' = so that (purpose). Compare avec pour + infinitif (same subject): 'J'étudie pour apprendre' vs 'J'étudie pour que tu comprennes.'")]),

// ── B2 LESSONS 2–30 (real content) ────────────────────────────────────────
  mkL("b2-02","Register & Nuance Control",35,"speaking",
    "B2 hallmark: controlling register! French has 3+ registers: familier/argotique (informal/slang — with friends), courant/standard (everyday), soutenu/littéraire (formal/literary — writing, speeches). Examples: manger/bouffer/dîner (to eat — standard/slang/formal). Knowing WHICH to use WHEN is advanced competency. Canadian workplace: standard to formal. Quebec friends: some informal is natural. CLB 7 test: formal throughout. Common register pitfalls: 'ya pas' vs 'il n'y a pas', 'c'est cool' vs 'c'est intéressant'.",
    ["registre familier: ya, ça fait que, genre, là","registre courant: standard, everyday speech","registre soutenu: discours, écrit formel, académique","manger → bouffer (fam) / se restaurer (soutenu)","beaucoup → vachement (fam) / considérablement (soutenu)","'pas de problème' → 'sans difficulté aucune'","adapter le registre au contexte et à l'interlocuteur","markers of sophistication: dont, lequel, subjonctif"],
    [mcq("In a formal job interview in Quebec, which is appropriate?",["'C'est cool, j'aime vraiment l'ambiance ici.'","'Je dois dire que l'atmosphère au sein de votre équipe me paraît particulièrement favorable à l'épanouissement professionnel.'","'Ouais, je feel que ça va bien marcher.'","'C'est super, je veux vraiment travailler icitte.'"],1,"The formal register! 'Paraît particulièrement favorable à l'épanouissement professionnel' is elevated vocabulary used appropriately in a formal context. 'Cool', 'feel', 'icitte' (Quebec informal for 'ici') are too casual for job interviews!"),
     mcq("'Il ne savait pas où donner de la tête' (he didn't know which way to turn) is:",["familier/argotique","courant","soutenu/littéraire","technical"],2,"Soutenu/littéraire — an idiomatic expression from formal French. B2 competency includes recognizing and using such expressions. Compare: familier: 'Il capotait' (Quebec for losing it), courant: 'Il était très stressé', soutenu: 'Il ne savait où donner de la tête.'"),
     wr("Rewrite formally: 'C'est pas possible de faire ça pour moi?'",["serait-il possible de","pourriez-vous","il m'est difficile de","je me permets de vous demander"],"Serait-il possible de procéder à ce changement pour moi? / Pourriez-vous effectuer cette modification en ma faveur? — Double register upgrade: 'c'est pas' → serait-il, 'possible' → kept but restructured, 'faire ça' → procéder à ce changement/effectuer cette modification. CLB 7 register control!")]),

  mkL("b2-03","Complex Connectors & Sophisticated Style",30,"writing",
    "Master the connectors that separate B1 from B2! Beyond parce que, de plus, cependant: CONCESSION: certes, il convient de reconnaître que, force est de constater que, nonobstant. CONSEQUENCE: c'est ainsi que, il s'ensuit que, de ce fait, par voie de conséquence. ADDITION: qui plus est, de surcroît, par ailleurs, voire (even). OPPOSITION: en revanche (on the other hand), à l'inverse, pour autant, il n'empêche que. CONDITION: pour peu que + subj, à supposer que + subj, dans l'hypothèse où.",
    ["force est de constater que (one must note that)","nonobstant (notwithstanding)","certes... cependant (admittedly... however)","qui plus est (moreover/what's more)","de ce fait / il s'ensuit que (as a result)","voire (even/or even)","à l'inverse / en revanche (on the contrary)","pour autant (for all that)","il n'empêche que (it doesn't change the fact that)","à supposer que + subj (assuming that)"],
    [mcq("'Force est de constater que les résultats sont insuffisants' means:",["It is impossible to note the results","One must acknowledge that the results are insufficient","The results force the conclusions","Despite everything, the results are good"],1,"Force est de constater que = one must acknowledge/it must be noted that. Used to introduce an uncomfortable but undeniable truth. Very B2+! 'Force est de constater que notre approche doit être révisée.' Shows intellectual honesty and sophistication."),
     mcq("'Voire' in 'C'est difficile, voire impossible' means:",["or/even (escalating the point)","definitely","however","because"],0,"Voire = or even (escalating). 'C'est difficile, voire impossible' = it's difficult, or even impossible. It moves from a lesser to a greater degree of the same idea. 'Cette mesure est utile, voire indispensable.' Sophisticated connector showing graduated emphasis!"),
     wr("Connect two contrasting ideas using 'en revanche'",["en revanche","à l'inverse","pour autant","il n'empêche que","cependant"],"Le télétravail offre une grande flexibilité. En revanche, il peut nuire aux liens sociaux et à la cohésion d'équipe. — En revanche = on the other hand (genuine contrast). Note: 'en revanche' is not simply = cependant. It contrasts two things of equal weight from different angles. CLB 7 precision!")]),

  mkL("b2-04","Passive Voice: All Tenses",25,"writing",
    "The passive voice in ALL tenses — needed for formal French writing! Pattern: être (any tense) + past participle. Présent: est approuvé. Imparfait: était examiné. Passé composé: a été envoyé. Plus-que-parfait: avait été soumis. Futur: sera traitée. Conditionnel: serait accepté. Subjonctif: soit examiné. Special: 'se faire' + inf for informal passive: 'Il s'est fait refuser' (He was refused). 'Se voir' + inf: 'Elle s'est vu attribuer le poste.'",
    ["Présent passif: est approuvé","Imparfait passif: était examiné","PC passif: a été envoyé","PQP passif: avait été soumis","Futur passif: sera traitée","Conditionnel passif: serait accepté","Subjonctif passif: soit examiné","se faire + inf (informal passive)","se voir + inf (passive for assigned actions)"],
    [mcq("'La loi avait été adoptée avant mon arrivée.' The tense of the passive verb is:",["passé composé","imparfait","plus-que-parfait","futur"],2,"Avait été adoptée = plus-que-parfait passif. Avait (IMP de avoir — wait: être!) → était... Actually: PQP de être = avait été? No: PQP passif = avait été + pp. Let's verify: PQP of passive = auxiliary in PQP (avait été) + pp. 'La loi avait été adoptée' = The law had been adopted (before another past event)."),
     mcq("'Il s'est fait refuser son visa.' This informal passive means:",["He refused his visa","His visa was refused (to him)","He refused himself","He accepted his visa"],1,"Se faire + infinitif = informal passive, often used when the subject is negatively affected. 'Il s'est fait refuser son visa' = His visa was refused / He had his visa refused. Very common in spoken French: 'Elle s'est fait voler son portefeuille' = Her wallet was stolen."),
     wr("Write a formal passive sentence about a policy change",["la politique a été","la mesure sera","les règlements ont été","la décision a été prise","le projet a été approuvé"],"La politique d'immigration a été révisée afin de mieux répondre aux besoins du marché du travail canadien. — Formal passive perfect for government and news contexts. 'A été révisée' = passé composé passif (has been revised). CLB 7-8 writing staple!")]),

  mkL("b2-05","Nominalization",30,"writing",
    "Nominalization = converting verbs/adjectives into nouns — a key formal French writing strategy! It makes writing more abstract and formal: 'Le gouvernement a décidé que...' → 'La décision du gouvernement de...' Common patterns: -tion/-sion (décider→décision, produire→production), -ment (développer→développement, gouverner→gouvernement), -age (utiliser→utilisation, gérer→gestion... wait: -ance/-ence (tolérer→tolérance, différer→différence), -ure (rompre→rupture). Using nominalizations allows longer, denser, more formal sentences.",
    ["-tion/-sion: décider→décision, produire→production","-(e)ment: développer→développement","-ance/-ence: tolérer→tolérance","-ure: rompre→rupture","-ée: entrer→l'entrée","-ité: complexe→complexité","Avantage: phrases plus denses et formelles","Risque: trop de nominalisation → lourd et obscur","Équilibre: mélanger verbes actifs et nominalisations"],
    [mcq("Nominalization of 'améliorer' (to improve):",["amélioreur","amélioration","amélioré","améliorant"],1,"Amélioration = improvement. This -tion nominalization is one of the most common. 'Il faut améliorer le système' → 'L'amélioration du système est nécessaire.' The nominalized version is more formal and abstract — typical of academic and official writing!"),
     mcq("'La mise en place de nouvelles politiques s'avère complexe.' The nominalized phrase is:",["s'avère complexe","nouvelles politiques","la mise en place de nouvelles politiques","complexe"],2,"La mise en place de = the implementation/setting up of. 'Mettre en place' → 'la mise en place'. The entire subject is a nominalized expression. Compare: 'Il s'avère complexe de mettre en place de nouvelles politiques.' Nominalization = more formal!"),
     wr("Nominalize this verb in a sentence: 'Les étudiants progressent rapidement.'",["la progression des étudiants est","le progrès des étudiants","la progression rapide des étudiants"],"La progression rapide des étudiants est remarquable. — 'Progresser' → 'la progression'. Note: 'le progrès' also works but is slightly different (progress as an achievement vs the act of progressing). Both acceptable at B2 level!")]),

  mkL("b2-06","Emphatic Constructions: C'est...qui/que",20,"speaking",
    "Emphatic constructions put focus on one element of the sentence! C'EST + [emphasized element] + QUI (for subjects) / QUE (for objects/complements). Examples: 'C'est lui qui a décidé' (It's HE who decided — emphasis on 'him'). 'C'est au Canada que j'ai appris le français' (It's in Canada that I learned French — emphasis on place). 'C'est pour cette raison que...' (It's for this reason that...). Extremely common in spoken French for emphasis and in formal writing for focus.",
    ["C'est + sujet + QUI (emphasizes subject)","C'est + objet/complément + QUE (emphasizes rest)","C'est lui qui a pris la décision","C'est au Québec que j'ai grandi","C'est pour cette raison que... (that's why)","C'est ce que je voulais vous dire","Ce sont + plural + qui/que","Ce n'est pas X qui... c'est Y qui..."],
    [mcq("'C'est le français que j'ai étudié en premier.' What is emphasized?",["the act of studying","the speaker","le français (the object emphasized)","the time"],2,"'Le français' is the emphasized element — it comes after 'c'est' and before 'que'. Without emphasis: 'J'ai étudié le français en premier.' With c'est...que: emphasis falls on LE FRANÇAIS. Useful for corrections: 'Ce n'est pas l'anglais que j'ai étudié, c'est le français!'"),
     mcq("'C'est ___ qui a signé le contrat.' To emphasize that SHE (not he) signed:",["lui","elle","que","ce sont"],1,"C'est elle qui — stressed pronoun (elle, not 'she'). After c'est: use stressed pronouns: moi, toi, lui, elle, nous, vous, eux, elles. 'C'est ELLE qui a signé' = It was SHE who signed (not him). Emphatic and used in spoken French for clarification!"),
     wr("Rewrite with emphasis on 'au Canada': 'J'ai décidé d'apprendre le français au Canada.'",["c'est au canada que j'ai décidé d'apprendre le français"],"C'est au Canada que j'ai décidé d'apprendre le français. — C'est + [au Canada] + que. The place is now the focus. This exact structure is useful in CLB 7 speaking when you want to make a specific element stand out in your narrative!")]),

  mkL("b2-07","Conditional Perfect: Regrets & Hypotheticals",30,"writing",
    "The conditional perfect = 'would have done' — used for: past regrets ('J'aurais dû partir plus tôt' — I should have left earlier), Type 3 conditionals ('Si j'avais su, je n'aurais pas signé' — If I had known, I wouldn't have signed), and reported future-in-past ('Il m'avait dit qu'il viendrait' vs 'qu'il serait venu'). Formation: avoir/être (conditional) + past participle. Same agreement rules as passé composé!",
    ["j'aurais + pp (I would have done)","elle serait venue (she would have come)","Si + PQP → conditionnel passé (type 3)","Si j'avais su, j'aurais agi différemment","J'aurais dû... (I should have)","J'aurais pu... (I could have)","J'aurais voulu... (I would have liked to)","Accord: elle serait arrivée (+e), ils auraient fini (-s)"],
    [mcq("'J'aurais dû prendre rendez-vous plus tôt.' This expresses:",["a future plan","a present regret","a past regret (I should have made an appointment earlier)","a condition"],2,"J'aurais dû = I should have (past regret). Devoir in conditional perfect = should have. 'J'aurais pu' = I could have, 'J'aurais voulu' = I would have liked to. All express past regret or missed opportunity. Very common in reflective narratives!"),
     mcq("Complete: 'Si elle avait étudié davantage, elle ___ réussi son examen.'",["aurait","aura","avait","aurait eu"],0,"Aurait réussi — si + plus-que-parfait (avait étudié) → conditionnel passé (aurait réussi). Type 3 conditional = impossible past hypothesis. 'She didn't study enough (past fact), so she didn't pass (past result). If she had studied, she would have passed.'"),
     wr("Express a past regret about your language learning",["j'aurais dû","j'aurais pu","si j'avais","j'aurais commencé","j'aurais pratiqué plus"],"J'aurais dû commencer à apprendre le français bien avant d'immigrer au Canada. Si j'avais pratiqué davantage dès le début, j'aurais progressé beaucoup plus rapidement. — Conditional perfect for past regrets! A reflective statement showing B2 grammar mastery.")]),

  mkL("b2-08","Concessive Structures",25,"writing",
    "Advanced concession at B2 — more than just 'mais'! CONCESSIVE CONJUNCTIONS (+ subjunctive): bien que (although), quoique (although), encore que (although — very formal), même si (even if — indicative!), si + adj + que (however + adj). PREPOSITIONAL PHRASES: malgré (despite + noun), en dépit de (despite + noun), nonobstant (notwithstanding). ADVERBS: pourtant (however/yet), néanmoins (nonetheless), toutefois (however/nonetheless — more formal).",
    ["bien que + subjonctif (although)","quoique + subjonctif (although — formal)","même si + indicatif (even if)","si difficile soit-il (however difficult it may be — very formal)","malgré + nom (despite)","en dépit de + nom (in spite of)","nonobstant + nom (notwithstanding)","pourtant / néanmoins / toutefois","avoir beau + inf: j'ai beau essayer, je n'y arrive pas"],
    [mcq("'Bien que je sois fatigué, je continue.' Correct?",["Oui — bien que + subjonctif ✓","Non — bien que + indicatif","Non — bien que + conditionnel","Non — bien que needs plus-que-parfait"],0,"Yes! Bien que + subjunctive is ALWAYS required. 'Je sois' = subjonctif of être. 'Bien que je sois fatigué' = although I am tired. Never: 'bien que je suis' — a very common B1 error that shows B2 mastery when corrected!"),
     mcq("'J'ai beau étudier, je n'y arrive pas.' This means:",["I study well and I succeed","Although I study (hard), I can't manage it","I barely study but I succeed","I study to succeed"],1,"Avoir beau + infinitif = although (doing something), the result is still the opposite. 'J'ai beau étudier' = even though I study (hard) / however much I study. Always negative result: 'J'ai beau expliquer, il ne comprend pas.' Very idiomatic French!"),
     wr("Write a sentence using 'malgré' to express a concession",["malgré les difficultés","malgré mes efforts","malgré le froid","malgré tout","malgré la distance"],"Malgré les nombreux défis de l'immigration, j'ai réussi à m'intégrer pleinement à la société canadienne. — Malgré + noun group (no verb!) for concession. Note: malgré que + subjonctif is controversial — avoid it in formal writing; use bien que instead!")]),

  mkL("b2-09","Vocabulary: Academic & Formal French",25,"reading",
    "Academic and formal vocabulary for B2/CLB 7-8! Key categories: ARGUMENTATION: étayer (support/back up), corroborer (corroborate), réfuter (refute), atténuer (soften/mitigate), nuancer (nuance). STRUCTURE: en premier lieu / premièrement (firstly), à titre d'exemple (as an example), il convient de souligner (it's worth noting), force est de constater (one must acknowledge), il ressort de (it emerges from). EVALUATION: pertinent (relevant), cohérent (coherent), fondé (well-founded), discutable (debatable).",
    ["étayer un argument (to back up an argument)","corroborer (to corroborate)","réfuter (to refute)","nuancer (to nuance/add nuance)","il convient de souligner (it's worth noting)","à titre d'exemple (as an example)","il ressort de (it emerges from)","pertinent/cohérent/fondé/discutable","prendre acte de (to take note of/acknowledge)","à cet égard (in this regard)","dans cette optique (from this perspective/with this in mind)"],
    [mcq("'Cet argument ne me semble pas suffisamment étayé' means:",["This argument is too long","This argument does not seem sufficiently supported/backed up","This argument is perfectly logical","This argument refutes my position"],1,"Étayer = to support/back up (with evidence, examples, facts). 'Un argument bien étayé' = a well-supported argument. 'Votre affirmation doit être étayée par des données concrètes.' = Your statement must be supported by concrete data. Key academic vocabulary!"),
     mcq("'Il ressort de cette étude que' introduces:",["a quotation","an objection","a main finding or conclusion drawn from the study","a definition"],2,"Il ressort de = it emerges from / it appears from. 'Il ressort de cette étude que 70% des immigrants maîtrisent le français après 2 ans.' Used to introduce findings or conclusions derived from research, studies, or data. Academic French!"),
     wr("Write a formal sentence presenting the main finding of a report",["il ressort de","selon ce rapport","les données montrent","cette étude révèle","il convient de noter que"],"Il ressort de ce rapport que l'intégration linguistique des immigrants au Québec progresse significativement lorsqu'ils bénéficient d'un accès aux cours de français subventionnés. — Academic sentence structure with il ressort de + finding + context. CLB 7-8 formal writing!")]),

  mkL("b2-10","Vocabulary: Current Affairs & Media",25,"reading",
    "Current affairs vocabulary for TEF Canada-level reading and listening! Key domains: POLITICS: la politique étrangère (foreign policy), le budget fédéral (federal budget), la réforme (reform), le projet de loi (bill), l'inflation (inflation). SOCIAL: l'itinérance (homelessness), la pénurie de logements (housing shortage), les services sociaux, la diversité et l'inclusion. ENVIRONMENT: les cibles climatiques (climate targets), l'urgence climatique (climate emergency). ECONOMY: la récession, la croissance, le taux de chômage (unemployment rate).",
    ["la politique étrangère (foreign policy)","le projet de loi (bill/draft law)","la pénurie de logements (housing shortage)","l'itinérance (homelessness)","le taux de chômage (unemployment rate)","l'inflation / le pouvoir d'achat (purchasing power)","les cibles climatiques (climate targets)","la réforme (reform)","le déficit / le surplus budgétaire","la récession / la croissance économique","la diversité et l'inclusion (D&I)"],
    [mcq("'La pénurie de logements' is a major issue in Canada referring to:",["too many available apartments","a shortage of available housing","expensive furniture","construction delays"],1,"Pénurie de logements = housing shortage — a critical issue across Canada, especially in Montreal, Toronto, and Vancouver. 'La crise du logement' (housing crisis) is now a top political issue. 'Les loyers augmentent en raison de la pénurie de logements.'"),
     mcq("'Le pouvoir d'achat' refers to:",["the right to purchase","purchasing power / what you can afford with your income","shop credit","government spending"],1,"Pouvoir d'achat = purchasing power — how much your income can actually buy given inflation and prices. 'L'inflation érode le pouvoir d'achat des ménages.' (Inflation erodes household purchasing power.) A key economic concept in current Canadian discussions!"),
     wr("Write a headline about a current Canadian economic issue",["la hausse des taux d'intérêt","la pénurie de logements","l'inflation","le taux de chômage","le budget fédéral"],"La Banque du Canada maintient son taux directeur face à une inflation persistante, selon une annonce du gouverneur mardi. — News headline structure: who (Banque du Canada) + what (maintains rate) + context (inflation) + source. Perfect CLB 7 reading task vocabulary!")]),

  mkL("b2-11","Vocabulary: Business & Economics",25,"reading",
    "Business and economic vocabulary for B2/CLB 7 professional contexts! Key terms: la croissance économique (economic growth), le PIB/produit intérieur brut (GDP), les investissements (investments), le marché boursier (stock market), les ressources humaines (HR), la chaîne d'approvisionnement (supply chain), la stratégie d'entreprise (business strategy), la fusion-acquisition (merger and acquisition), le bilan comptable (balance sheet), le chiffre d'affaires (revenue/turnover), la rentabilité (profitability).",
    ["la croissance économique (economic growth)","le PIB (GDP)","les investissements (investments)","le chiffre d'affaires (revenue)","la rentabilité (profitability)","les ressources humaines (HR)","la chaîne d'approvisionnement (supply chain)","la fusion-acquisition (M&A)","le bilan comptable (balance sheet)","la stratégie d'entreprise","le partenariat (partnership)","l'actionnaire (shareholder)"],
    [mcq("'Le chiffre d'affaires de l'entreprise a augmenté de 15% cette année.' This means:",["profits increased by 15%","total revenue/turnover increased by 15%","staff count increased by 15%","market share increased by 15%"],1,"Chiffre d'affaires = revenue/turnover (total sales, NOT profit). Profit = bénéfice net. Revenue - costs = profit. 'Notre chiffre d'affaires est de 5M$, mais notre bénéfice net est de 500 000$.' This distinction is crucial in business French!"),
     mcq("'La fusion-acquisition' refers to:",["a staff merger","a company merger or acquisition (M&A)","a bank loan","a business license"],1,"Fusion-acquisition = M&A (merger and acquisition). 'Fusion' = merger (two companies become one), 'acquisition' = one company buys another. Very common in Canadian business news: 'La fusion entre X et Y créera le plus grand groupe bancaire canadien.' CLB 7 business vocabulary!"),
     wr("Write a sentence about a business challenge using B2 vocabulary",["la rentabilité","la croissance","les ressources humaines","la chaîne d'approvisionnement","le marché","les investissements"],"Face à la hausse des coûts et aux perturbations de la chaîne d'approvisionnement, de nombreuses entreprises canadiennes revoient leur stratégie afin de préserver leur rentabilité à long terme. — B2 business sentence with nominalization and sophisticated vocabulary!")]),

  mkL("b2-12","Essay Structure: French Academic Writing",30,"writing",
    "Master the structure of French academic essays at B2+ level! The French essay has a specific structure: INTRODUCTION (amener le sujet → poser la problématique → annoncer le plan). DÉVELOPPEMENT (thèse → antithèse → synthèse/solution OR two arguments + concession). CONCLUSION (bilan + ouverture). Key difference from English: French academic writing values logical progression, formal register, and systematic argumentation. The 'plan dialectique' (thesis-antithesis-synthesis) is the gold standard!",
    ["Introduction: amener → poser → annoncer","Plan dialectique: thèse-antithèse-synthèse","Ou plan analytique: arg1 + arg2 + concession","Conclusion: bilan + ouverture","Transitions entre parties: 'Cela étant, il convient d'examiner...'","Formules d'introduction de partie: 'En premier lieu...'","La problématique (central question)","Registre soutenu tout au long"],
    [mcq("The 'problématique' in a French essay is:",["the list of problems","the central question or issue that drives the essay","the conclusion","the introduction"],1,"La problématique = the central question the essay addresses. In French academic writing, you must state the problématique clearly in the introduction: 'Dans quelle mesure X influence-t-il Y?' or 'Comment expliquer le phénomène de X?' Everything in the essay answers this question!"),
     mcq("The 'ouverture' at the end of a French essay conclusion serves to:",["repeat the introduction","summarize all arguments again","open up a broader perspective or related question","introduce a new argument"],2,"L'ouverture = opening up to a broader perspective. 'Cette réflexion nous invite à nous interroger sur... / En définitive, cette question rejoint le débat plus large sur...' It shows intellectual breadth — you can see beyond the immediate question. Required at B2+ level!"),
     wr("Write a problématique for an essay about French language policy in Quebec",["dans quelle mesure","comment expliquer","en quoi","la question est de savoir","peut-on affirmer que"],"Dans quelle mesure les politiques linguistiques québécoises parviennent-elles à protéger et à promouvoir le français tout en favorisant l'intégration des immigrants? — Perfect problématique: poses a nuanced question with two dimensions (protection of French + immigrant integration), showing awareness of tension!")]),

  mkL("b2-13","Writing: 200-word Opinion Essay",35,"writing",
    "Write a complete 200-word B2 opinion essay! This is the TEF Canada expression écrite benchmark. Full essay: introduction (30-35 words: context + thesis), argument 1 (50-60 words: claim + explanation + example), argument 2 (50-60 words: claim + explanation + example), concession (25-30 words: opposing view acknowledged), conclusion (25-30 words: restatement + ouverture). Time yourself: 25 minutes maximum. Check: word count, all accents, register, logic.",
    ["200 mots ± 10%","Introduction: 30-35 mots","Argument 1: 50-60 mots","Argument 2: 50-60 mots","Concession: 25-30 mots","Conclusion: 25-30 mots","Temps: 25 min maximum","Relire: mots comptés, accents, registre, logique"],
    [mcq("In a 200-word essay, the concession paragraph should:",["take up half the essay","be the longest paragraph","be shorter (25-30 words) — acknowledge, then pivot back","be the introduction"],2,"25-30 words for concession. 'Certes, [opposing view]. Toutefois, [your position reinforced].' The concession shows intellectual balance but must NOT undermine your thesis — just acknowledge the other side briefly before reinforcing your main argument. Short but powerful!"),
     mcq("The word 'nonobstant' in a 200-word essay is:",["too formal and should be avoided","a sophisticated B2 connector showing register mastery","informal language","only for legal documents"],1,"Nonobstant = notwithstanding — highly formal. Using it correctly in a 200-word essay signals excellent register control. B2 = knowing which register to use when. In a formal essay = sophisticated connectors are appropriate and rewarded!"),
     wr("Write a 35-word introduction for: 'L'immigration enrichit-elle la société canadienne?'",["à l'heure où","le canada accueille","la question de","je soutiens que","dans cet essai"],"À l'heure où le Canada accueille un nombre record de nouveaux arrivants, la question de l'apport de l'immigration à la société canadienne s'impose avec acuité. Je soutiens que cette diversité constitue, à tout égard, une richesse fondamentale. (~35 words — context + thesis, ready for development!)")]),

  mkL("b2-14","Writing: Formal Letter & Appeal",30,"writing",
    "Write formal letters for professional and administrative purposes at B2 level! Types: lettre d'appel (appeal letter — contesting a decision), lettre de réclamation avancée (advanced complaint), lettre de demande officielle (official request). Advanced features: quote specific laws or regulations, use conditional perfect for hypotheticals, express consequences professionally. Key formulas: 'Par la présente, je me permets de contester la décision...' / 'Je fais appel de cette décision conformément à l'article...'",
    ["Par la présente, je me permets de... (hereby, I take the liberty)","Je fais appel de... (I appeal / contest)","Conformément à l'article X de la loi Y (pursuant to article X)","La décision contestée est... (the contested decision is)","Les motifs de mon appel sont les suivants: (grounds for appeal)","Je demande qu'il soit procédé à... (I request that... be done)","À défaut de réponse satisfaisante... (failing a satisfactory response)","Je vous prie d'agréer, Madame/Monsieur, l'expression de mes sentiments distingués"],
    [mcq("'Je fais appel de la décision rendue le [date]' means:",["I support the decision made on [date]","I am appealing / contesting the decision made on [date]","I made the decision on [date]","I am applying for a decision on [date]"],1,"Faire appel de = to appeal / contest (a decision). 'Je fais appel de cette décision' = I am appealing this decision. 'Appel' in legal/administrative context = formal challenge to a decision. Used for: immigration refusals, benefit denials, professional decisions!"),
     mcq("'Les motifs de mon appel sont les suivants' introduces:",["your credentials","the grounds/reasons for your appeal","your closing remarks","a request for information"],1,"Motifs = grounds/reasons. 'Les motifs de mon appel sont les suivants:' = The grounds for my appeal are as follows: — then you list 1, 2, 3 specific reasons. This organized presentation of grounds is essential in formal appeals. Each ground should reference facts or relevant regulations!"),
     wr("Write the opening line of an appeal letter contesting an immigration decision",["par la présente","je me permets de contester","je fais appel de","conformément à","suite à la décision"],"Par la présente, je me permets de contester la décision de refus rendue le [date] concernant ma demande de [type de permis/statut], référence numéro [X], conformément aux droits d'appel prévus par la législation canadienne en matière d'immigration. — Professional, specific, cites legal rights.")]),

  mkL("b2-15","Writing: Analytical Summary",30,"writing",
    "Write an analytical summary (synthèse analytique) — a B2/TEF Canada writing skill! Different from simple summary: you don't just retell the text, you ANALYZE it. Structure: 1) Briefly identify the text (type, topic, context — 1-2 sentences). 2) Present the main argument/thesis. 3) Identify key supporting points (don't list everything). 4) Note the author's stance and rhetorical approach. 5) Your critical observation (1 sentence). Length: 80-120 words. Register: formal throughout.",
    ["Identifier: type de texte, sujet, contexte","Thèse principale: l'auteur soutient que...","Points-clés (sélection, pas tout!)","Posture de l'auteur: neutre, engagé, critique?","Observation critique (1 phrase)","80-120 mots maximum","Paraphrase — jamais de citations longues!","Pas d'opinions personnelles détaillées (juste observation finale)"],
    [mcq("An analytical summary differs from a regular summary because it:",["is shorter","includes your personal opinion throughout","identifies the text type, author stance, and includes a brief critical observation","only lists the main points"],2,"Analytical = identify + evaluate. Beyond retelling: you note the TEXT TYPE (editorial? report?), the AUTHOR'S STANCE (neutral? engaged?), and add one CRITICAL OBSERVATION. This level of meta-commentary is what makes it 'analytical' vs just 'descriptive.'"),
     mcq("In an analytical summary, you should:",["quote extensively from the original text","paraphrase the main ideas in your own words","only write what you personally agree with","translate the text"],1,"Paraphrase = essential skill! Never reproduce more than 10-15 words from the original. Restate the ideas in your own words — this demonstrates real comprehension AND writing ability. 'L'auteur affirme que...' / 'Selon l'article,...' / 'Ce texte soutient l'idée que...' — all good paraphrase openings!"),
     wr("Write a 2-sentence analytical summary opening for a news article about housing",["cet article","ce reportage","l'auteur de cet article","ce texte traite de","il s'agit d'un article"],"Cet article de fond, publié dans La Presse, aborde la crise du logement qui sévit dans les grandes villes canadiennes. L'auteur soutient que la pénurie de logements abordables résulte d'une combinaison de politiques inadéquates et de spéculation immobilière, appelant à une intervention urgente des gouvernements. — 2 sentences: identification + main thesis = strong analytical summary opening!")]),

  mkL("b2-16","Speaking: Extended Monologue (5 minutes)",35,"speaking",
    "The 5-minute sustained monologue — the B2/TEF Canada speaking benchmark! At this level your monologue must: begin with a clear contextualization (not just 'I think'), develop 3 distinct points (not just 2), include a genuine concession with rebuttal, use sophisticated connectors throughout, maintain formal register for the full 5 minutes, and conclude with an ouverture (broader perspective). Practice timing: use your phone. A 5-minute monologue = approximately 600-700 words spoken at natural pace.",
    ["5 minutes = ~600-700 mots au rythme naturel","Contextualisation (ne pas commencer par 'je pense')","3 points distincts (pas juste 2)","Concession forte avec contre-argument","Connecteurs sophistiqués tout au long","Registre formel maintenu","Conclusion + ouverture (perspective plus large)","Pratiquer avec chronomètre!"],
    [mcq("A 5-minute B2 monologue should open with:",["'Je pense que...' directly","contextualization of the topic before stating your position","a question to the audience","listing all your arguments immediately"],1,"Contextualization first! Don't jump straight to your opinion. 'La question de X s'inscrit dans un contexte de... Face à ces enjeux, il convient de s'interroger sur... À mon sens,...' — this 20-30 second contextualisation shows you can situate a topic before arguing about it. B2+ sophistication!"),
     sp("Deliver a sustained B2 monologue (aim for 3–5 min) on « L'intelligence artificielle va-t-elle remplacer les travailleurs? ». Begin with contextualisation (not 'je pense'), develop three distinct points, include a concession with rebuttal, and end with an ouverture.","Dans un contexte de transformation technologique accélérée, la question de l'impact de l'intelligence artificielle sur l'emploi s'impose comme un enjeu majeur. Premièrement, l'IA automatise certaines tâches répétitives, ce qui supprime des postes. Deuxièmement, elle crée toutefois de nouveaux métiers liés à sa conception et à sa supervision. Troisièmement, elle transforme les emplois existants plutôt que de les éliminer entièrement. Certes, les transitions seront douloureuses pour certains secteurs ; cependant, l'histoire montre que chaque révolution technologique a fini par créer plus d'emplois qu'elle n'en a détruits. Cela soulève la question de la formation continue, véritable clé de l'avenir du travail.",["dans un contexte de","premièrement","deuxièmement","troisièmement","certes","cependant","cela soulève la question"],"A 5-minute B2 monologue: contextualize the topic, develop three distinct points, concede with a rebuttal, and close with an ouverture. Hold the formal register the whole way through."),
     wr("Write a 30-second contextualization for: 'L'IA va-t-elle remplacer les travailleurs?'",["la question de l'intelligence artificielle","dans un contexte de","face aux avancées technologiques","cette problématique","il convient de s'interroger"],"Dans un contexte de transformation technologique accélérée, la question de l'impact de l'intelligence artificielle sur le marché du travail s'impose comme l'un des grands enjeux économiques et sociaux de notre époque. Face aux avancées spectaculaires de l'IA générative, il convient de s'interroger sur les véritables implications pour l'emploi humain. — ~45 words, perfect B2 contextualization!")]),

  mkL("b2-17","Speaking: Debate & Argumentation",25,"speaking",
    "Advanced debate skills at B2 level — for TEF speaking and professional contexts! Beyond CLB 6 (justify your position), B2 debate: anticipate objections proactively, use rhetorical questions effectively, cite data/studies, appeal to shared Canadian values, and 'reframe' the debate when needed. Reframing: 'La vraie question n'est pas X, mais Y.' Building on opponent: 'Vous avez raison sur X, cependant...' Conceding a point strategically: 'Je vous accorde ce point, toutefois...'",
    ["Anticiper: 'On pourrait objecter que... mais...'","Reframer: 'La vraie question est...'","Citation de données: 'Selon une étude de...'","Valeurs canadiennes: multiculturalisme, inclusion","Je vous accorde ce point, toutefois... (I grant you that, however)","Vous avez raison sur X, mais il n'en demeure pas moins que...","Question rhétorique: 'N'est-il pas évident que...?'","Conclure avec un appel à l'action ou valeur partagée"],
    [mcq("'La vraie question n'est pas X, mais Y' is a technique called:",["concession","reframing the debate","giving up your argument","asking a rhetorical question"],1,"Reframing = shifting the terms of the debate to more favorable ground. 'La vraie question n'est pas de savoir si l'immigration coûte cher, mais de mesurer ses contributions nettes à long terme.' This changes what's being debated — a sophisticated debate move!"),
     sp("Reframe and rebut out loud: your opponent argues « L'immigration coûte trop cher à l'État. » Reframe the real question, concede strategically, then pivot with (approximate) data and a rhetorical question.","La vraie question n'est pas de savoir si l'immigration coûte cher à court terme, mais de mesurer ses contributions nettes à long terme. Je vous accorde que l'accueil exige des investissements initiaux. Il n'en demeure pas moins que, selon plusieurs études économiques, les immigrants génèrent, sur dix à vingt ans, des bénéfices fiscaux supérieurs aux coûts. N'est-il pas plus juste, dès lors, de parler d'investissement plutôt que de dépense?",["la vraie question n'est pas","je vous accorde","il n'en demeure pas moins","selon","n'est-il pas"],"B2 debate: reframe ('la vraie question est…'), concede strategically ('je vous accorde…'), pivot with evidence, and finish with a rhetorical question."),
     wr("Strategically concede a point then pivot to your main argument",["je vous accorde","certes, vous avez raison sur","c'est un point valide, cependant","je comprends cet argument, toutefois","il est vrai que... néanmoins"],"Je vous accorde que l'intégration des immigrants représente un défi réel pour les services publics à court terme. Il n'en demeure pas moins que, sur une période de 10 à 20 ans, les données économiques démontrent systématiquement que l'immigration génère des bénéfices nets considérables pour le Canada. — Strategic concede + data-backed pivot!")]),

  mkL("b2-18","Speaking: Register Control Practice",25,"speaking",
    "Demonstrate full register control in speaking — from formal to informal and back! B2 competency: you can consciously choose your register and shift it appropriately. Practice: same content, 3 registers. Formal (interview): 'Je me spécialise dans le domaine de la santé publique.' Standard (colleague): 'Je travaille dans la santé publique.' Informal (friend): 'Ouais, je travaille dans la santé, genre les politiques de santé.' The test: can you code-switch naturally and purposefully?",
    ["Registre formel: lexique soutenu, syntaxe élaborée","Registre courant: standard, quotidien professionnel","Registre familier: contractions, argot léger","Code-switching = adapter selon l'interlocuteur","Marqueurs formels: je ne saurais, il convient, nonobstant","Marqueurs informels: ouais, ben, pis, ça fait que","L'accent québécois n'est PAS un registre familier!","Test: même idée, 3 registres différents"],
    [mcq("Code-switching in language means:",["making errors in two languages","consciously adapting your register to the context and audience","switching entirely to another language","speaking incorrectly"],1,"Code-switching = consciously adapting your language register (not necessarily your language!) to the context. Using formal French in a job interview and informal French with friends is code-switching. It's a sign of linguistic sophistication — not confusion!"),
     sp("Register control — say the SAME idea out loud in two registers. Formal (to a director): then informal (to a friend): « Je travaille dans les politiques de santé publique. »","Registre formel : Je me spécialise dans le domaine des politiques de santé publique. Registre familier : Ouais, moi je travaille dans la santé, genre dans les politiques de santé.",["je me spécialise","politiques de santé","je travaille dans la santé","genre"],"B2 = producing the same content in different registers on demand. Notice what shifts: vocabulary ('je me spécialise' vs 'je travaille'), and fillers ('genre', 'ouais') appear only in the informal version."),
     wr("Say 'I'm exhausted after this long meeting' in 3 different registers",["je suis épuisé après cette longue réunion (courant)","cette réunion m'a complètement éreinté (soutenu)","je suis vraiment crevé après cette réunion (familier)"],"Formel: Cette réunion prolongée m'a particulièrement épuisé. Courant: Je suis vraiment fatigué après cette longue réunion. Familier: Ah là là, je suis complètement crevé après cette réunion-là! — Three registers, same idea. B2 = you can produce all three on demand!")]),

  mkL("b2-19","Listening: Authentic Radio/Podcast French",30,"listening",
    "Understand authentic French media at B2/CLB 7 level! Key resources: Radio-Canada (Ici Radio-Canada Première), Espaces.ca, RFI Savoirs, Plus on est de fous plus on lit (CBC Radio). Challenges: fast speech, overlap, Quebec accent, cultural references, idioms. Strategy: 1) Listen 2-3 times minimum. 2) First listen: topic and general structure. 3) Second listen: main points. 4) Third listen: details and evidence. 4) Note idioms and new vocabulary.",
    ["Ressources: Radio-Canada, RFI, ICI Première","Stratégie d'écoute multi-passages","Première écoute: thème général","Deuxième écoute: points principaux","Troisième écoute: détails et nuances","Accent québécois: 'pis' = et puis, 'ben' = bien","Expressions idiomatiques québécoises","Repérer les invités, leurs opinions, leurs arguments"],
    [mcq("In Quebec French radio, 'pis' is a contraction of:",["puis seulement","et puis/puis (and then)","oui pis non","pas"],1,"Pis = et puis / puis (informal: and then / also). Very common in spoken Quebec French: 'J'suis allé au dépanneur, pis après j'suis revenu.' You'll hear this constantly on Radio-Canada informal segments. Understanding 'pis' is essential for following natural Quebec speech!"),
     li("Ah pis là, l'invité, y nous explique que le télétravail, c'est ben beau, mais qu'à long terme, ça pourrait nuire à l'esprit d'équipe. Selon lui, faudrait trouver un équilibre, genre deux ou trois jours au bureau pis le reste à la maison.","Quelle est l'opinion de l'invité sur le télétravail?",["Il faudrait un équilibre : quelques jours au bureau","Le télétravail devrait être obligatoire pour tous","Le télétravail n'a aucun inconvénient","Il faut interdire complètement le télétravail"],0,"Authentic Quebec radio register: 'pis' (et puis), 'ben beau' (all well and good), 'genre', 'faudrait'. The guest argues for balance — « faudrait trouver un équilibre, genre deux ou trois jours au bureau ». Decoding informal Quebec speech is the B2/CLB 7 challenge.",{diff:4,transcriptEn:"So the guest is explaining that remote work is all well and good, but that in the long run it could hurt team spirit. According to him, we'd need to find a balance, like two or three days at the office and the rest at home."}),
     wr("Name 2 French-language media resources in Canada you'll use for practice",["radio-canada","ici radio-canada première","le devoir","la presse","journal de montréal","le soleil","tv5","rdi"],"Radio-Canada / Ici Radio-Canada Première + Le Devoir or La Presse. Radio-Canada is the public broadcaster — excellent quality, clear pronunciation, diverse topics. Le Devoir is serious journalism. Journal de Montréal is more popular/accessible. Use all levels of media!")]),

  mkL("b2-20","Listening: Conference & Lecture French",25,"listening",
    "Understand conference presentations and academic lectures at B2 level! Structure of academic French presentations: annonce du plan (outline), développement par points (main points), transitions (passons maintenant à, j'aborde à présent), récapitulatif (summary), conclusion et ouverture (conclusion and opening to questions). Key vocabulary: la problématique (issue/research question), le cadre théorique (theoretical framework), les données empiriques (empirical data), les résultats (results/findings).",
    ["Annonce du plan: 'Je vais aborder trois points...'","Transition: 'Passons maintenant à...'","Récapitulatif: 'En résumé, nous avons vu que...'","Ouverture: 'Cela soulève la question de...'","la problématique (research question/issue)","les données (data)","les résultats / les conclusions (results/conclusions)","selon les recherches de... (according to research by...)","il convient de nuancer (one should nuance this)"],
    [mcq("'Je vais vous présenter trois points principaux.' In a lecture, this signals:",["the conclusion","the introduction/plan announcement","a transition","a question from the audience"],1,"Plan announcement = the speaker tells you the structure in advance. Listen carefully and use it as a roadmap! 'Trois points' = you'll take 3 sets of notes. Academic speakers in French always announce their structure — use it to organize your comprehension!"),
     li("Bonjour à tous. Je vais aborder aujourd'hui trois points. Premièrement, le cadre théorique de notre étude. Deuxièmement, les données empiriques recueillies auprès de mille participants. Et troisièmement, les résultats, qui révèlent une corrélation inattendue entre l'apprentissage des langues et la mémoire à long terme.","Combien de points l'oratrice va-t-elle aborder, et quel est le troisième?",["Trois points ; le troisième porte sur les résultats","Deux points ; le dernier sur la théorie","Trois points ; le troisième sur les participants","Un seul point, sur la mémoire"],0,"Academic speakers announce their plan — use it as a roadmap for your notes. « trois points… troisièmement, les résultats, qui révèlent une corrélation… ». Catch the structure first, details second.",{diff:4,transcriptEn:"Hello everyone. Today I'll address three points. First, the theoretical framework of our study. Second, the empirical data collected from a thousand participants. And third, the results, which reveal an unexpected correlation between language learning and long-term memory."}),
     wr("Write a transition sentence moving from point 1 to point 2 in a presentation",["passons maintenant à","j'aborde à présent","après avoir examiné","nous avons vu que","je me penche à présent sur"],"Après avoir examiné les défis linguistiques des immigrants au Canada, j'aborde à présent les solutions proposées par les experts et les politiques gouvernementales en place. — Perfect academic transition: summarizes point 1 briefly, introduces point 2, connects them logically. CLB 7 presentation language!")]),

  mkL("b2-21","Reading: Complex Literary/Academic Text",25,"reading",
    "Read complex texts at B2/CLB 7 level! Types: scholarly articles (articles scientifiques), opinion pieces (chroniques, éditoriaux), literary excerpts (extraits littéraires), policy documents. Strategies: 1) Identify text type and purpose. 2) Note structure (introduction-development-conclusion). 3) Distinguish facts, opinions, and inferences. 4) Infer meaning of unknown words from context. 5) Identify the author's stance (nuanced? partisan? objective?). Key skill: reading critically, not just for information.",
    ["Type de texte: identifier d'abord","But de l'auteur: informer, persuader, analyser?","Fait vs opinion vs inférence","Point de vue de l'auteur: neutre, partial, engagé?","Vocabulaire par contexte (déduction)","Structure: thèse, antithèse, synthèse","Registre: soutenu, académique, journalistique","Question critique: 'À qui s'adresse ce texte?'"],
    [rd("Si l'apprentissage d'une langue seconde à l'âge adulte demeure pleinement possible, il serait illusoire de prétendre qu'il s'effectue selon les mêmes mécanismes que chez l'enfant. Les recherches en neurolinguistique suggèrent en effet que la plasticité cérébrale décline avec l'âge. Néanmoins, cette contrainte est largement compensée, chez l'adulte, par des stratégies métacognitives et une motivation souvent plus soutenue.","Quelle est la thèse nuancée de l'auteur?",["L'adulte apprend différemment, mais peut compenser par la motivation et la métacognition","Les adultes sont incapables d'apprendre une langue seconde","Les enfants et les adultes apprennent de façon strictement identique","La plasticité cérébrale augmente avec l'âge"],0,"The thesis is balanced: 'pleinement possible… mais pas les mêmes mécanismes… Néanmoins… compensée'. The 'Néanmoins' pivot carries the author's nuanced position — adults learn differently but can compensate. Tracking that pivot is core B2/CLB 7 reading.",{title:"Article — neurolinguistique",glossary:[["illusoire","illusory"],["néanmoins","nevertheless"],["soutenu","sustained"]],diff:4}),
     mcq("A text is 'partial' (partial) when:",["it covers only half the topic","it's incomplete","the author presents a biased viewpoint (taking sides)","it's written in parts"],2,"Partial (un texte partial) = biased, taking one side. 'Partiel' = incomplete (only covers part). False cognate alert! 'Cet article est partial — l'auteur ne présente que les arguments en faveur de sa thèse.' vs 'Cette analyse est partielle — elle n'examine qu'un aspect du problème.'"),
     wr("Write a critical observation about a text you recently read",["l'auteur soutient que","ce texte défend la thèse","il convient de noter que","bien que l'argument soit","force est de constater"],"Bien que l'auteur soutienne une thèse convaincante sur l'importance du bilinguisme au Canada, force est de constater que son analyse demeure partielle, car elle néglige les réalités des communautés francophones hors Québec. — Critical reading response at CLB 7+ level!")]),

  mkL("b2-22","Reading: News Analysis",25,"reading",
    "Critically analyze French-language news at B2 level! Beyond comprehension: identify framing (cadrage), implicit assumptions (présupposés), emotional language (langue émotionnelle), political bias (biais politique), omissions (ce qui n'est pas dit — what's NOT said). Quebec media landscape: La Presse (centrist/online), Le Devoir (intellectual), Journal de Montréal (populaire/conservative), Radio-Canada (public). Critical reading = essential for informed citizenship in Canada!",
    ["Le cadrage (framing) d'un article","Les présupposés implicites (implicit assumptions)","Langue émotionnelle vs neutre","Identifier les sources citées et leur fiabilité","Ce qui n'est PAS dit (omissions)","La Presse vs Le Devoir vs Journal de Montréal","Biais: lexique choisi révèle la position","Question: à qui profite cet article?"],
    [rd("Encore une fois, le gouvernement a échoué à contenir la flambée des prix. Pendant que les familles peinent à joindre les deux bouts, les grandes entreprises engrangent des profits record. Faut-il vraiment s'étonner, dès lors, que la colère gronde dans la population?","Quel procédé l'auteur utilise-t-il principalement?",["Une langue émotionnelle et un cadrage accusateur","Une présentation neutre, fondée sur des chiffres","Un ton humoristique et léger","Une analyse purement statistique"],0,"This is framing analysis. Charged language ('a échoué', 'peinent à joindre les deux bouts', 'engrangent des profits record') plus a closing rhetorical question build an accusatory frame — the opposite of neutral reporting. Naming the device is B2 news analysis.",{title:"Chronique d'opinion",glossary:[["la flambée","the surge"],["engranger","to rake in"],["gronder","to rumble / grow"]],diff:4}),
     mcq("'It goes without saying that' in a text often signals:",["a neutral observation","a hidden assumption presented as obvious","a fact with evidence","a question"],1,"Presenting something as obvious ('il va sans dire que', 'évidemment', 'bien entendu') is a rhetorical technique that embeds assumptions without defending them. Critical readers notice these 'it goes without saying' claims and ask: does it really? For whom? Why?"),
     wr("Identify one implicit assumption in this headline: 'Les immigrants coûtent cher à l'État'",["cette affirmation","la phrase suppose que","le titre implique que","le présupposé est que","cette affirmation ignore"],"Ce titre implique que les immigrants reçoivent plus de l'État qu'ils n'y contribuent, ce qui est un présupposé discutable. Des études montrent en réalité que l'immigration génère des bénéfices économiques nets à long terme. — Critical reading + counter-evidence = CLB 7-8 analytical skill!")]),

  mkL("b2-23","TEF Canada: Listening Strategy",30,"listening",
    "TEF Canada listening section: 3 parts, increasing difficulty. Part 1: 5 short recordings (everyday messages, ~1 min each). Part 2: 4 longer recordings (interviews, news — ~2-3 min each). Part 3: 2 long recordings (conference, debate — ~4-5 min each). 40 questions total, 40 minutes. Strategy: read questions BEFORE each audio, take notes (provided paper), answer immediately — you hear each recording ONCE (no replay in TEF!). Quebec accent throughout!",
    ["TEF: 3 parties (difficultés croissantes)","Partie 1: courts messages (everyday)","Partie 2: enregistrements moyens (interviews, nouvelles)","Partie 3: longs enregistrements (conférence, débat)","40 questions en 40 minutes","Écoute UNIQUE — pas de réécoute!","Lire les questions AVANT l'audio","Prise de notes sur papier fourni","Accent québécois tout au long"],
    [mcq("In the TEF Canada listening section, each recording is heard:",["once only","twice","three times","you can replay as needed"],0,"Once only — no replay in TEF! This is the biggest difference from practice exercises. You must: 1) Read questions BEFORE listening, 2) Take notes DURING (keywords, numbers, names), 3) Answer IMMEDIATELY after. Practice with Radio-Canada without replay to simulate test conditions!"),
     li("Bonjour, c'est Madame Lévesque de la garderie Les Petits Soleils. Je vous appelle pour vous rappeler que la garderie sera fermée le vendredi 3 mai en raison d'une journée pédagogique. Pensez à prendre vos dispositions. Merci et bonne journée!","Pourquoi la garderie sera-t-elle fermée, et quand?",["Le vendredi 3 mai, pour une journée pédagogique","Le lundi 3 mai, pour des rénovations","Le vendredi 13 mai, pour un congé férié","Toute la semaine, pour cause de maladie"],0,"TEF rule: you hear it ONCE. Catch the essentials fast — « vendredi 3 mai… journée pédagogique ». Read the question first, note the date + reason, answer immediately.",{once:true,diff:3,transcriptEn:"Hello, this is Mrs. Lévesque from Les Petits Soleils daycare. I'm calling to remind you that the daycare will be closed on Friday May 3 due to a professional development day. Please make arrangements. Thank you and have a good day!"}),
     wr("List 3 things you'll do before each TEF listening audio plays",["lire les questions","identifier les mots-clés","préparer mon papier de notes","rester concentré","noter les options de réponse"],"1) Je lis toutes les questions de cette section. 2) J'identifie les mots-clés dans chaque question (date? lieu? opinion?). 3) Je prépare ma feuille de notes et me concentre. — 3-step pre-listening routine. Do this every time in practice to make it automatic for test day!")]),

  mkL("b2-24","TEF Canada: Speaking Tasks",30,"speaking",
    "TEF Canada expression orale: 2 tasks recorded at a test centre. Task 1: describe/explain (15 min preparation, 8-10 min recording). Task 2: give opinion/debate (15 min preparation, 8-10 min recording). Assessment: range and accuracy of expression, vocabulary, coherence/organization, fluency, pronunciation. Preparation strategy: notes are allowed during prep time. Structure your response FIRST on paper, then record. Quebec accent is perfectly acceptable!",
    ["TEF: 2 tâches d'expression orale","Tâche 1: décrire/expliquer (narratif)","Tâche 2: donner son opinion/débattre","15 minutes de préparation par tâche","8-10 minutes d'enregistrement","Plan sur papier pendant la préparation","Critères: gamme, précision, cohérence, aisance, prononciation","L'accent québécois est parfaitement acceptable!","Commencer fort, conclure fort"],
    [mcq("During TEF speaking preparation time, you should:",["memorize a prepared speech on the topic","read a script word for word","structure your response with bullet points and key vocabulary","sit quietly without taking notes"],2,"Use every second of prep time! Write: thesis (position), 3-4 main points, key vocabulary, examples, transition words, conclusion. Then record using your notes. You can glance at notes during recording — it's allowed! Structured = higher score."),
     sp("TEF Task 2 simulation — speak ~2 min giving and defending an opinion on « Les villes devraient-elles limiter les voitures au centre-ville? ». Structure: position → two arguments → concession → conclusion.","À mon avis, les villes devraient effectivement limiter la circulation automobile au centre-ville. D'une part, cela réduirait la pollution et améliorerait la qualité de l'air. D'autre part, cela encouragerait le transport en commun et les déplacements actifs. Certes, certains commerçants craignent une baisse de clientèle ; cependant, les expériences européennes montrent souvent l'effet inverse. En conclusion, une limitation bien planifiée bénéficie à la fois à l'environnement et à la vitalité urbaine.",["à mon avis","d'une part","d'autre part","certes","cependant","en conclusion"],"TEF speaking task 2: a clear position, two structured arguments, a concession with rebuttal, and a conclusion — delivered in a confident, organized flow. Quebec accent is perfectly acceptable."),
     wr("Write your 5-point plan for a TEF opinion task on immigration",["introduction: position","argument 1:","argument 2:","concession:","conclusion:"],"1) Introduction: À mon avis, l'immigration enrichit le Canada économiquement et culturellement. 2) Arg 1: Contribution économique — combler les pénuries de main-d'œuvre. 3) Arg 2: Diversité culturelle — innovation et créativité. 4) Concession: Certes, défis d'intégration. 5) Conclusion: Avec des politiques d'intégration adéquates, les bénéfices dépassent les défis. — Perfect TEF plan!")]),

  mkL("b2-25","TEF Canada: Writing Simulation",35,"writing",
    "TEF Canada expression écrite: 2 tasks, 45 minutes total. Task 1: write a structured message/email (100-150 words, 15-20 min). Task 2: write an opinion essay (200-250 words, 25-30 min). Assessment: task completion, organization, vocabulary range, grammatical accuracy, spelling. Checklist: ✓ Both tasks completed, ✓ Correct word count (count your words!), ✓ Formal register, ✓ All requested elements included, ✓ No spelling errors (check accents!), ✓ Logical connectors throughout.",
    ["TEF: 2 tâches en 45 minutes","Tâche 1: message/courriel (100-150 mots, 15-20 min)","Tâche 2: essai d'opinion (200-250 mots, 25-30 min)","Compter ses mots! (count your words)","Vérifier: tous les éléments demandés?","Orthographe et accents! (spell-check mentally)","Structure essai: intro-arg1-arg2-concession-conclusion","Connecteurs logiques — variés et précis"],
    [mcq("For the TEF 200-word essay, the best time management is:",["write as much as possible with no plan","spend all 45 minutes on the essay","5 min plan + 20 min writing + 5 min review for task 2","write task 2 first, task 1 last"],2,"5-20-5 for task 2 (essay): 5 min planning + 20 min writing + 5 min review. Task 1 (message): 15-20 min. Total: ~40 min + 5 min buffer. ALWAYS leave time to review both tasks for spelling errors, missing accents, and forgotten task elements!"),
     mcq("If you write 180 words for a 200-word task:",["that's fine — approximate is OK","you will lose major points for being too short","you should remove some words","you should add irrelevant content to reach 200"],1,"Word count matters! TEF graders check length. Below minimum = penalized. 'Environ 200 mots' = aim for 190-220. Never go 20% below the target. Add: an extra example, a nuance, an additional argument. But don't add random words — add SUBSTANCE!"),
     wr("Write the first paragraph of a 200-word TEF essay on bilingualism in Canada",["l'enjeu du bilinguisme","à mon avis","le Canada est un pays bilingue","la langue est un vecteur","dans cet essai"],"Dans un pays officiellement bilingue comme le Canada, la maîtrise des deux langues officielles — le français et l'anglais — représente un enjeu identitaire et économique fondamental. À mon avis, encourager activement le bilinguisme est non seulement souhaitable, mais nécessaire pour maintenir la cohésion sociale et la compétitivité internationale du pays. Dans les lignes qui suivent, j'exposerai les raisons de cette conviction. — ~50 words: strong TEF essay opening!")]),

  mkL("b2-26","TEF Canada: Reading Strategies",25,"reading",
    "TEF Canada compréhension écrite: 3 parts, 60 minutes, 50 questions. Part 1: 15 questions on short texts (notices, ads, emails). Part 2: 20 questions on medium texts (articles — scan for info). Part 3: 15 questions on long complex texts (inference, analysis). Strategy: allocate time! 12 min Part 1, 25 min Part 2, 20 min Part 3, 3 min review. Don't spend too long on one question — mark, move on, return. All questions carry equal weight.",
    ["TEF lecture: 3 parties, 60 min, 50 questions","Partie 1: textes courts (annonces, courriels) — 12 min","Partie 2: textes moyens (articles) — 25 min","Partie 3: textes longs (inférence) — 20 min","Gestion du temps: ne pas s'attarder!","Questions d'inférence = lire entre les lignes","Questions littérales = retourner au texte précis","Toutes les questions valent le même poids","Si incertain: eliminer, choisir, continuer"],
    [mcq("For TEF Part 3 (long complex texts), the best strategy is:",["read every word slowly and carefully","only read questions","skim text first, then read questions, then find answers","skip to the end"],2,"Skim + question + targeted re-read. For 15 complex questions on a long text: 1) Skim whole text (2 min) to understand structure and topic. 2) Read each question. 3) Find the relevant section and re-read carefully for THAT answer. This is faster than reading everything carefully first!"),
     rd("Communiqué — La Ville de Québec lance, dès le 1er septembre, un programme de subventions destiné aux propriétaires qui rénovent leur logement pour le rendre plus écoénergétique. Les subventions, pouvant atteindre 5 000 $, couvrent l'isolation, le remplacement des fenêtres et l'installation de thermopompes. Les demandes doivent être déposées en ligne avant le 30 novembre. Seuls les bâtiments construits avant l'an 2000 sont admissibles.","Quels bâtiments sont admissibles à la subvention?",["Ceux construits avant l'an 2000","Tous les bâtiments, sans exception","Seulement les bâtiments neufs","Seulement les immeubles commerciaux"],0,"TEF reading = locate the precise condition. The eligibility clause is the last sentence: « Seuls les bâtiments construits avant l'an 2000 sont admissibles. » Watch for restrictive words like 'seuls' — they decide the answer.",{title:"Communiqué municipal",glossary:[["écoénergétique","energy-efficient"],["une thermopompe","a heat pump"],["admissible","eligible"]],diff:3}),
     wr("Write your TEF reading time allocation for 60 minutes and 3 parts",["partie 1: 12 min","partie 2: 25 min","partie 3: 20 min","révision: 3 min","total: 60 min"],"Partie 1 (textes courts): 12 minutes / Partie 2 (articles): 25 minutes / Partie 3 (textes longs): 20 minutes / Révision: 3 minutes = 60 minutes total. STICK TO THIS! Set mental checkpoints: at 12 min, move to Part 2; at 37 min, move to Part 3. Don't let one section consume all your time!")]),

  mkL("b2-27","TEF Mock Exam Practice 1",35,"integrated",
    "First full TEF Canada simulation! This session mimics real test conditions: timed, all 4 skills, test-format questions. Your realistic CLB score target after B2: CLB 7 (TEF score: ~600/900). Reminder of full TEF format: Compréhension orale (40 questions, 40 min), Expression orale (2 tasks, 30 min prep + recording), Compréhension écrite (50 questions, 60 min), Expression écrite (2 tasks, 45 min). Total: ~4 hours. Practice all sections regularly!",
    ["TEF format: 4 épreuves","Compréhension orale: 40 questions, 40 min","Expression orale: 2 tâches, ~30 min total","Compréhension écrite: 50 questions, 60 min","Expression écrite: 2 tâches, 45 min","Score TEF: /900 → converti en niveau","CLB 7 ≈ 600+/900 (varie selon l'épreuve)","Résultats valides 2 ans (à vérifier avec IRCC)","S'inscrire via le CCFL (Centre canadien de FLL)"],
    [mcq("TEF Canada total score is:",["out of 100","out of 400","out of 900","out of 1200"],2,"TEF Canada total = out of 900 (4 sections × max 225 each). Your CLB level is determined by the score in each section. For immigration: check current IRCC score requirements as they vary by program and change over time! The CCFL website has current conversion tables."),
     mcq("TEF Canada results are valid for:",["1 year","2 years","5 years","forever"],1,"2 years from test date. Plan accordingly: take the TEF close to when you need the results for immigration, citizenship, or professional recognition. 'Mes résultats TEF sont valides jusqu'au [date].' Check IRCC for latest requirements as they may update!"),
     wr("Write your TEF Canada preparation plan for the next 3 months",["mois 1: je vais réviser","mois 2: je vais pratiquer","mois 3: je ferai des simulations","chaque semaine","tous les jours"],"Mois 1: Révision de la grammaire B2 et du vocabulaire thématique. Mois 2: Pratique intensive des 4 compétences avec des exercices format TEF. Mois 3: 2 simulations complètes par semaine + correction des erreurs. Inscription au TEF Canada 3 semaines avant la date choisie. — Structured, realistic 3-month plan!")]),

  mkL("b2-28","TEF Mock Exam Practice 2",35,"integrated",
    "Second TEF simulation and error analysis! After each practice exam: 1) Analyse your errors — grammar? vocabulary? listening speed? 2) Categorize: which skill needs most work? 3) Focus study sessions on weakest areas. 4) Track progress over time. Common weak points for B1→B2 learners: subjunctive in writing, pronoun order, academic vocabulary, listening to rapid speech, maintaining formal register for 200+ words. Address these systematically!",
    ["Analyse des erreurs après simulation","Catégoriser: quelle compétence améliorer?","Erreurs fréquentes B1→B2: subjonctif, pronoms, vocabulaire","Écoute: habituer à la vitesse naturelle","Écriture: maintenir le registre formel sur 200 mots","Progression: noter ses scores par semaine","Ressources: La Presse, Le Devoir, Ici Radio-Canada","Pratique quotidienne = progrès garantis"],
    [mcq("The most effective way to improve after a practice TEF test:",["take the same test again","ignore errors and take a new test","analyse each error type, identify the pattern, study that specific area","only practice listening"],2,"Error analysis + targeted study = fastest improvement. If you got 3 subjunctive questions wrong: study subjunctive triggers for 2 days. If listening is weak: 30 min/day of Radio-Canada without subtitles. TARGETED practice is more efficient than random review!"),
     mcq("To maintain formal register in a 200-word essay, you should:",["write informally then translate to formal","check each sentence for informal language markers","write as quickly as possible","copy phrases from examples"],1,"Check each sentence! Red flags: 'c'est pas', 'ya', 'ben', 'ouais', 'ça fait que', contractions omitting 'ne'. Fix these before the next sentence. Writing formally is a habit — build it in practice so it's automatic in the test!"),
     wr("Identify your weakest TEF skill and write a 2-week improvement plan",["ma compétence la plus faible est","je vais pratiquer","chaque jour je vais","je ferai","je vais regarder/lire/écrire"],"Ma compétence la plus faible est l'expression écrite. Pendant 2 semaines: Je vais écrire un paragraphe d'opinion de 100 mots chaque jour. Je vais lire des articles du Devoir et imiter leur style. Le weekend, je ferai un essai complet de 200 mots en 25 minutes. Résultat attendu: +30 points en expression écrite. — Specific, measurable, achievable plan!")]),

  mkL("b2-29","B2 Full Assessment",40,"integrated",
    "B2 FINAL ASSESSMENT — comprehensive CLB 7-8 evaluation! This is your dress rehearsal for TEF Canada. Full assessment: 1) Read a complex editorial (500 words) and answer inference questions. 2) Write a 200-word opinion essay on a current Canadian topic. 3) Listen to a 5-minute radio segment and summarize key points. 4) Deliver a 4-minute structured opinion monologue. If you complete all four successfully, you are TEF Canada ready at CLB 7+ level. Extraordinaire accomplissement!",
    ["Évaluation B2 complète: 4 compétences","Lecture: éditorial complexe + inférences","Écriture: essai 200 mots (25 min)","Écoute: segment radio 5 min + résumé","Expression orale: monologue 4 min","Critères: niveau TEF Canada CLB 7+","Auto-évaluation honnête","Identifier ce qui reste à renforcer"],
    [mcq("At CLB 7/B2 level, you should be able to:",["only handle basic everyday conversations","communicate in most situations with occasional difficulty","handle complex and abstract topics fluently and flexibly","function as a native French speaker in all contexts"],1,"CLB 7 = proficient user. You can handle complex and abstract topics, write formally and fluently, understand most authentic French media, and interact confidently in professional settings. Occasional errors remain but don't impede communication. This is immigration and professional recognition level!"),
     mcq("'L'intégration linguistique' for immigrants in Quebec means:",["learning English","learning French to function in Quebec society","obtaining a passport","translating documents"],1,"L'intégration linguistique = linguistic integration — learning French well enough to participate fully in Quebec society (work, civic life, education, culture). The Quebec government funds 'cours de francisation' (French integration courses) — you may be eligible as a newcomer!"),
     wr("Write your B2 achievement statement in French",["j'ai atteint le niveau b2","je suis maintenant capable de","je peux communiquer","je me prépare pour le tef","j'ai complété"],"J'ai complété avec succès le niveau B2 du programme Franco. Je suis maintenant capable de communiquer de manière autonome et nuancée en français dans des contextes professionnels, civiques et académiques au Canada. Je suis prêt(e) à passer l'examen TEF Canada pour obtenir la certification CLB 7+. Félicitations à moi-même!")]),

  mkL("b2-30","B2 Certification Ready — Your Path Forward",25,"integrated",
    "You've completed the full Franco curriculum — from zero French to B2/CLB 7 readiness! Your journey: Foundation (20 lessons) → A1 (40 lessons) → A2 (40 lessons) → B1 (40 lessons) → B2 (30 lessons) + CLB Test Prep (20 lessons) = 190 lessons! What comes next: TEF Canada exam registration, CLB 7 certification, language recognition for immigration, citizenship, or professional licensing. You've built something remarkable — a new language, a new life in Canada!",
    ["Bilan du programme Franco: 190 leçons","Foundation → A1 → A2 → B1 → B2 → CLB Prep","Votre niveau actuel: B2 / CLB 7","Prochaine étape: inscription au TEF Canada","CCFL (Centre canadien de FLL) — lieu d'inscription","Résultats sous 3 semaines","Valides 2 ans pour immigration et citoyenneté","Ressources continues: Radio-Canada, La Presse, Le Devoir","Pratiquer tous les jours — même 15 minutes","Vous avez réussi quelque chose d'extraordinaire!"],
    [mcq("After completing B2 Franco, your recommended next step is:",["start learning a third language","register for the TEF Canada exam at CCFL","stop practicing French since you've finished","take B2 again"],1,"Register for TEF Canada at the Centre canadien de français langue (CCFL). Bring: valid ID, immigration documents if needed. Book at least 3-4 weeks in advance — spots fill quickly! Results arrive in 2-3 weeks. Your B2 Franco training has prepared you well!"),
     mcq("The Franco curriculum total lesson count is:",["52 lessons","100 lessons","150 lessons","190 lessons"],3,"190 lessons: 20 Foundation + 40 A1 + 40 A2 + 40 B1 + 30 B2 + 20 CLB Prep = 190 total. Each level is carefully designed to build on the previous. You started with Bonjour and you're finishing ready for TEF Canada. What an achievement!"),
     wr("Write what Franco has meant for your Canadian journey",["franco m'a aidé","grâce à franco","j'ai appris","je suis maintenant capable","mon objectif","la langue française"],"Grâce au programme Franco, j'ai acquis les compétences linguistiques nécessaires pour m'intégrer pleinement à la société canadienne. La langue française n'est plus un obstacle mais un atout dans ma vie professionnelle et sociale au Québec. Je continue mon chemin avec confiance. Merci à tous ceux qui m'ont soutenu dans cette aventure! — Félicitations! 🎉")])

];

// ─────────────────────────────────────────────────────────────────────────────
// CLB TEST PREP — 20 LESSONS
// ─────────────────────────────────────────────────────────────────────────────
const CLB_LESSONS = [
  mkL("clb-01","Understanding the CLB System",20,"reading",
    "The Canadian Language Benchmarks (CLB) measure English/French ability for newcomers. 12 levels across 4 skills: Listening, Speaking, Reading, Writing. CLB 1-4 = basic, CLB 5-8 = intermediate, CLB 9-12 = advanced. For Canadian immigration: Express Entry often requires CLB 7 in all 4 skills (NCLC equivalent for French). TEF Canada = the main French test used for immigration.",
    ["CLB 1-4 (basic)","CLB 5-8 (intermediate)","CLB 9-12 (advanced)","TEF Canada = test for immigration","4 skills: écouter, parler, lire, écrire","NCLC = Niveaux de compétence linguistique canadiens","Résidence permanente: souvent CLB 7+","Citoyenneté: CLB 4+ minimum"],
    [mcq("CLB 7 in all 4 skills is often required for:",["tourism visa","Express Entry immigration","student visa","working holiday visa"],1,"Express Entry (the main Canadian immigration pathway) typically requires CLB 7 in all 4 language skills for French (measured by NCLC). Lower levels may qualify for some programs. TEF Canada measures this!"),
     mcq("The TEF Canada test is used for:",["French school registration","Immigration and citizenship in Canada","University admission in France","Tourism visa applications"],1,"TEF Canada = Test d'Évaluation de Français (adapted for Canadian immigration). It's administered by the CCFL (Centre canadien de français langue) and is accepted for Express Entry, citizenship, and professional recognition."),
     wr("Write what CLB level you're targeting and why",["je vise","mon objectif","je travaille pour atteindre","je prépare"],"Je vise le CLB 5/7/9 parce que... — Having a clear goal makes learning more effective! Your CLB target affects which lessons and drills are most important. 'Je me prépare pour le TEF Canada afin d'obtenir ma résidence permanente.'")]),



  mkL("clb-02","CLB 4 Listening: Extract Key Information",25,"listening",
    "CLB 4 listening tasks: extract specific information from short, clear recordings. Recordings at CLB 4: voicemail messages, short announcements, simple instructions, store hours/prices, weather forecasts. The speaker speaks clearly and at moderate pace. Focus on: numbers (prices, dates, times, quantities), names (people, places, organizations), and action words (call, bring, arrive, complete). Always read the question first, then listen specifically for the answer!",
    ["Écoute CLB 4: enregistrements courts et clairs","Focus: chiffres, dates, heures, noms","Types: messages téléphoniques, annonces, horaires","Stratégie: lire la question → écouter → noter","Vocabulaire courant et familier","Vitesse modérée (pas de radio rapide)","Repérer l'information spécifique demandée","CLB 4 ≈ A2 / début B1"],
    [mcq("At CLB 4, the listening recordings are characterized by:",["complex academic lectures","clear speech at moderate pace on familiar topics","rapid radio segments with background noise","technical professional discussions"],1,"CLB 4 = clear, moderate pace, familiar topics. The speaker speaks clearly (not mumbling, not too fast), on topics you encounter in everyday Canadian life (store, doctor, bank, schedule). Good news: if you've completed A2 Franco lessons, you're CLB 4 ready!"),
     li("Bonjour et bienvenue chez Marché Provigo. Notre magasin est ouvert du lundi au samedi, de neuf heures à vingt heures, et le dimanche de onze heures à dix-sept heures. Merci de votre visite et bonne journée!","Quelles sont les heures d'ouverture le dimanche?",["De 11 h à 17 h","De 9 h à 20 h","De 9 h à 17 h","Fermé le dimanche"],0,"Listen for the specific detail asked: « le dimanche de onze heures à dix-sept heures » = 11 h–17 h. Jot times down as you hear them — numbers fade from memory fast.",{diff:2,transcriptEn:"Hello and welcome to Marché Provigo. Our store is open Monday to Saturday, 9 a.m. to 8 p.m., and Sunday 11 a.m. to 5 p.m. Thank you for visiting and have a good day!"}),
     wr("Write the 3 key things to note when listening to a voicemail",["le nom de l'appelant","l'objet de l'appel","le numéro de rappel","la date et l'heure","l'urgence du message"],"1) Nom et organisation de l'appelant, 2) Raison de l'appel / message principal, 3) Numéro de rappel et délai. These 3 pieces of information let you respond appropriately to any voicemail. Write them down immediately before they fade from memory!")]),

  mkL("clb-03","CLB 4 Speaking: Describe Your Routine",20,"speaking",
    "CLB 4 speaking: describe your daily life clearly and coherently. You should be able to speak for 1-1.5 minutes on your daily routine without major hesitations. Use: present tense for habits, time markers (d'abord, puis, ensuite, le matin/soir), specific details (times, places, activities). CLB 4 allows: occasional errors that don't impede communication, simple vocabulary, short sentences. What matters: being understood, staying on topic, completing the task!",
    ["Parler 1-1.5 min sans pauses longues","Vocabulaire: routines quotidiennes","Marqueurs de temps: d'abord, puis, le matin...","CLB 4: quelques erreurs permises si compréhensible","Rester sur le sujet","Donner des détails précis (heures, lieux)","Éviter les longs silences (utiliser 'euh, donc...')","Auto-correction brève si erreur"],
    [mcq("At CLB 4 speaking, you are assessed primarily on:",["perfect grammar with zero errors","being understood and completing the communication task","using very advanced vocabulary","speaking with no accent"],1,"CLB 4 = communication first! Assessors ask: Can I understand this person? Did they complete the task? Occasional errors, simple vocabulary, and an accent are ALL acceptable at CLB 4. Focus on: clear message, staying on topic, appropriate length (1-1.5 min)!"),
     sp("Speak for about a minute: describe your typical day (« une journée typique »). Use time markers — le matin, d'abord, ensuite, puis, le soir — and give specific times and places.","Le matin, je me lève à six heures et demie et je prends un café. Ensuite, je prépare les enfants pour l'école. Puis, je prends l'autobus pour aller au travail, ce qui prend environ trente minutes. Le soir, je cuisine le souper et je regarde les nouvelles avant de me coucher.",["le matin","d'abord","ensuite","puis","le soir","je me lève"],"CLB 4 speaking: be understood, stay on topic, and link your ideas with time markers. Small errors are fine — clarity and completing the task matter most."),
     wr("Describe your typical morning in 3 sentences",["je me lève","le matin","d'abord","je prends","puis je","je pars"],"Le matin, je me lève à 6h30 et je prends une douche rapide. Ensuite, je mange mes céréales en écoutant les nouvelles. Puis, je prends le bus pour aller au travail — ça prend environ 25 minutes. — 3 sentences: clear routine, time markers, specific details = CLB 4 speaking success!")]),

  mkL("clb-04","CLB 4 Reading: Understand a Notice",20,"reading",
    "CLB 4 reading: understand short informational texts. Types: building notices, workplace announcements, school flyers, store signs, transit announcements. You need to: identify the main purpose, extract specific information (dates, times, locations, requirements), understand what action is needed. Strategy: read the title first (tells you the topic), then scan for key information asked in the question. Most CLB 4 reading texts are 100-200 words.",
    ["Textes CLB 4: 100-200 mots","Avis, annonces, flyers, panneaux","Identifier: le but (but = purpose) du texte","Extraire: dates, heures, lieux, exigences","Action requise: que doit-on faire?","Stratégie: titre → survol → réponse","Vocabulaire: avis, à compter du, prière de, veuillez","Longueur modérée, registre standard"],
    [mcq("Reading a building notice: 'Interruption d'eau chaude le jeudi 20 mars de 8h à 16h pour entretien.' What should residents expect?",["No water at all on March 20","No hot water from 8am to 4pm on Thursday March 20","No hot water for 20 days","The building will be closed"],1,"No hot water (pas d'eau chaude) from 8h to 16h (8am-4pm) on Thursday March 20. 'Entretien' = maintenance (reason given). Cold water is still available — only hot water is interrupted. Reading notices carefully = extract the SPECIFIC information (hot vs cold, hours, date)!"),
     rd("AVIS AUX RÉSIDENTS\n\nEn raison de travaux d'entretien, l'eau chaude sera interrompue le jeudi 20 mars, de 8 h à 16 h. L'eau froide demeurera disponible durant toute la journée. Prière de ne pas utiliser la machine à laver pendant cette période. Nous vous remercions de votre compréhension.","D'après l'avis, qu'est-ce qui sera interrompu, et quand?",["L'eau chaude, le jeudi 20 mars de 8 h à 16 h","Toute l'eau, pendant 20 jours","L'électricité, le 20 mars","L'eau froide, le jeudi soir"],0,"Read for the specific detail: only l'eau chaude is cut, jeudi 20 mars, 8 h–16 h, for « travaux d'entretien ». L'eau froide stays available. 'Prière de' = please (do). Catch what + when + the requested action.",{title:"Avis aux résidents",glossary:[["l'entretien","maintenance"],["demeurer","to remain"],["prière de","please (do)"]],diff:2}),
     wr("Write the key information from this notice: 'La bibliothèque sera fermée le 1er mai pour la Fête du Travail.'",["la bibliothèque ferme","le 1er mai","fête du travail","fermée","fermeture exceptionnelle"],"La bibliothèque sera fermée le 1er mai en raison de la Fête du Travail (jour férié). — Key info: what (bibliothèque), when (1er mai), why (fête du travail = public holiday). Simple CLB 4 notice reading!")]),

  mkL("clb-05","CLB 4 Writing: Form & Short Note",20,"writing",
    "CLB 4 writing: complete a form accurately and write a short functional note (30-60 words). Form completion: legible, accurate, complete (no blanks). Short note types: absence explanation, thank-you note, simple request, appointment confirmation. Language at CLB 4: may have errors but must be comprehensible, basic vocabulary, short sentences, appropriate format (date, greeting, closing). Focus on: completing the task, not linguistic perfection.",
    ["Remplir un formulaire: lisible, précis, complet","Note courte: 30-60 mots","Types: absence, remerciement, demande simple","CLB 4: erreurs permises si le message est clair","Format: date, salutation, corps, signature","Vocabulaire de base mais pertinent","Ponctuation simple et correcte","Majuscule au début de chaque phrase"],
    [mcq("When completing a form in French, 'prénom' means:",["last name/surname","first name/given name","full name","date of birth"],1,"Prénom = first name/given name. Nom de famille = last name/surname. A very common mistake! On Canadian French forms: Nom = last name, Prénom = first name. Always check which is which!"),
     mcq("A 30-60 word note should NOT contain:",["a greeting","a clear request or message","a closing","a 5-paragraph essay structure"],3,"30-60 words = short functional note. No need for a full essay structure — just: greeting + clear message + closing. 'Bonjour Madame, Je vous écris pour... [message]. Cordialement, [Nom].' Complete but concise!"),
     wr("Write a 40-word absence note for your child who was sick",["veuillez excuser","mon enfant","était absent","pour cause de maladie","merci de bien vouloir","cordialement"],"Bonjour, Je vous informe que mon enfant, [Prénom], était absent le [date] pour cause de maladie. Je vous fournis ci-joint un billet médical. Merci de bien vouloir l'excuser. Cordialement, [Nom]. — ~40 words, complete, CLB 4 functional writing!")]),

  mkL("clb-06","CLB 5 Listening: Service Interactions",25,"listening",
    "CLB 5 listening: understand service interactions (bank, CLSC, government office, employer) of 3-5 minutes. The speakers speak at natural speed with occasional interruptions. You need to: understand the purpose, extract specific details (procedures, deadlines, amounts, requirements), identify the speakers' roles, and understand what action is required. New at CLB 5: multiple speakers, some background noise, occasional Quebec expressions.",
    ["Interaction de service: 3-5 minutes","Vitesse naturelle, quelques interruptions","Identifier les interlocuteurs et leurs rôles","Comprendre la procédure expliquée","Repérer: délais, montants, exigences, actions requises","CLB 5: plusieurs locuteurs possibles","Accent québécois standard","Nouvelle difficulté: inférer ce qui est implicite"],
    [mcq("In a CLB 5 service interaction, you might need to infer:",["every single word","what the caller needs to do next, even if not directly stated","only the names of speakers","only the topic"],1,"At CLB 5, you must sometimes INFER the next step from context. If a bank employee says 'Votre demande de carte a été approuvée — vous la recevrez dans 7 à 10 jours ouvrables', you can infer: no action needed, just wait. This inference skill is what separates CLB 4 from CLB 5!"),
     li("Bonjour, je vous appelle de Service Canada au sujet de votre demande d'assurance-emploi. Votre dossier est presque complet, mais il nous manque une preuve de résidence. Vous devrez donc nous rappeler avec votre numéro de dossier afin de finaliser le tout.","Que doit faire la personne, et avec quoi?",["Rappeler avec son numéro de dossier pour fournir une preuve de résidence","Se présenter en personne avec son passeport","Payer des frais en ligne immédiatement","Attendre une lettre, sans rien faire"],0,"Catch both the action and what to have ready: « rappeler avec votre numéro de dossier » + what's missing (« une preuve de résidence »). At CLB 5 you must extract the required action, not just the topic.",{diff:3}),
     wr("What 3 questions should you ask after a service interaction to check comprehension?",["qu'est-ce que je dois faire?","quand est-ce que je dois le faire?","qu'est-ce que je dois apporter?","quel est le délai?","quel est le numéro de référence?"],"1) Qu'est-ce que je dois faire exactement? (What exactly do I need to do?) 2) Dans quel délai? (By when?) 3) Quels documents/informations dois-je avoir? (What do I need to have?) These 3 questions ensure you understood the action required — essential for CLB 5 service interactions!")]),

  mkL("clb-07","CLB 5 Speaking: Give an Opinion",25,"speaking",
    "CLB 5 speaking: express and justify your opinion on a familiar topic for 1.5-2 minutes. Structure: state your opinion → give reason 1 + example → give reason 2 + example → conclude. New at CLB 5: you should maintain your position if asked, use some complex sentences, and employ a range of connectors beyond 'parce que'. Topics: work, school, neighbourhood, environment, Canadian life, immigration experiences.",
    ["1.5-2 minutes d'opinion structurée","Énoncer la position clairement","Raison 1 + exemple concret","Raison 2 + exemple concret","Conclusion: donc, c'est pourquoi","Maintenir la position si challengé","Connecteurs: parce que, car, de plus, cependant","Quelques structures complexes","Vocabulaire varié (pas les mêmes mots répétés)"],
    [mcq("At CLB 5 speaking, which is most important?",["using only complex grammar","giving a perfect structure with sophisticated vocabulary","communicating your opinion clearly with justification","speaking for exactly 2 minutes"],2,"Communicating clearly WITH justification = CLB 5 core. Structure + reasoning = CLB 5 speaking. Perfect grammar? Not required. Exact timing? Close is fine. Clear, justified opinion? Essential! 'I think X because Y and Z' consistently delivered = CLB 5."),
     sp("Speak ~1.5–2 minutes: give and justify your opinion on « Devrait-on encourager le télétravail? ». State your position, give two reasons with examples, then conclude.","À mon avis, on devrait encourager le télétravail. Premièrement, il réduit le temps de transport : par exemple, j'économise une heure chaque jour. Deuxièmement, il permet un meilleur équilibre entre la vie professionnelle et la vie familiale. Cependant, il faut maintenir un contact régulier avec l'équipe. En conclusion, le télétravail, bien organisé, est bénéfique.",["à mon avis","premièrement","par exemple","deuxièmement","cependant","en conclusion"],"CLB 5: clear position + two justified reasons with examples + a nuance + conclusion. Push your connectors beyond 'parce que'."),
     wr("State your opinion on working from home in 2 sentences",["à mon avis, le télétravail","selon moi","je pense que travailler de la maison","le travail à distance"],"À mon avis, le télétravail offre une meilleure qualité de vie grâce à la flexibilité des horaires et à l'élimination des temps de transport. Cependant, il peut nuire aux relations avec les collègues et à la collaboration d'équipe. — 2 sentences: opinion + justification + nuance = CLB 5 speaking!")]),

  mkL("clb-08","CLB 5 Reading: Scan for Information",20,"reading",
    "CLB 5 reading: efficiently scan medium-length texts (200-400 words) to find specific information. Text types at CLB 5: job postings, news articles, service descriptions, schedules, informational brochures. New challenge: the texts are longer and contain more information — you must distinguish essential from non-essential. Strategy: question first → identify keyword → scan for keyword → read that section closely → answer.",
    ["Textes CLB 5: 200-400 mots","Types: offres d'emploi, articles, brochures, horaires","Distinguer l'essentiel du non-essentiel","Stratégie: question → mot-clé → scan → lire section → réponse","CLB 5: quelques questions d'inférence","Vocabulaire: professionnel, gouvernemental","Identifier le ton et le but du texte","Lire les titres et sous-titres en premier"],
    [mcq("In a job posting, to find the required education level, you scan for:",["the company name","the job title","words like 'formation', 'diplôme', 'études requises', 'DEC', 'BAC'","the application deadline"],2,"Scan for vocabulary clusters: 'Formation requise / Scolarité / Diplôme exigé / DEC en... / BAC en...' These signal the education section. Different companies format this differently — scanning for the vocabulary cluster is faster than reading everything!"),
     rd("OFFRE D'EMPLOI — Préposé(e) au service à la clientèle\n\nEntreprise : Boutique Nordik (Laval)\nTâches : accueillir les clients, traiter les commandes, gérer les retours.\nExigences : DEP ou DEC, bilinguisme (français-anglais), six mois d'expérience.\nConditions : 35 h/semaine, 22 $/h, assurances collectives après 3 mois.\nPour postuler : envoyez votre CV à emplois@nordik.ca avant le 30 juin.","Quelles sont les exigences de formation et de langue?",["DEP ou DEC et le bilinguisme français-anglais","Un baccalauréat universitaire seulement","Aucune exigence particulière","Le français uniquement, sans diplôme"],0,"Scan the « Exigences » section rather than reading every line: « DEP ou DEC, bilinguisme (français-anglais), six mois d'expérience. » Finding the right vocabulary cluster fast is the CLB 5 scanning skill.",{title:"Offre d'emploi",glossary:[["les exigences","requirements"],["DEP / DEC","Quebec vocational / college diplomas"],["postuler","to apply"]],diff:3}),
     wr("List 3 sections you'd find in a typical Quebec job posting",["exigences / qualifications requises","responsabilités / tâches","conditions de travail / avantages","salaire / rémunération","lieu de travail","comment postuler"],"1) Exigences/qualifications requises (education, experience, skills), 2) Responsabilités principales (main duties), 3) Conditions et avantages (salary, hours, benefits). These 3 sections help you decide quickly if a job is worth applying for!")]),

  mkL("clb-09","CLB 5 Writing: Formal Email (80 words)",25,"writing",
    "CLB 5 writing: compose a formal email of approximately 80 words covering all requested elements. CLB 5 emails must: complete all parts of the task prompt, use formal register throughout (vous, no contractions of 'ne'), include proper salutation and closing, organize logically. New at CLB 5: the email must address 2-3 different sub-tasks (e.g., explain your situation + make a request + ask a question). Length is important — aim for 70-90 words.",
    ["CLB 5: courriel formel de ~80 mots","Compléter TOUTES les parties de la consigne!","Registre formel: vous, ne...pas complet","Objet clair et spécifique","Corps: 2-3 sous-tâches à adresser","Salutation et clôture formelles","Relire: tous les éléments demandés présents?","Orthographe: accents obligatoires en français!"],
    [mcq("An 80-word formal email that covers only 2 of 3 requested tasks:",["is acceptable if the grammar is perfect","will lose points for incomplete task completion","is fine if it's well-organized","will be forgiven if the writing is sophisticated"],1,"INCOMPLETE TASK = major penalty. Even perfect grammar doesn't compensate for missing task elements. The CLB 5 grader checks: did they include task element 1? 2? 3? If no to any: point deduction. ALWAYS re-read the task prompt after writing to verify completion!"),
     mcq("In a formal French email, 'ne' in negation:",["can always be dropped","should always be kept (ne...pas, ne...jamais, ne...rien)","is only kept in literature","is only in formal letters, not emails"],1,"In formal writing (and formal emails), ALWAYS keep the ne! 'Je ne peux pas' not 'Je peux pas'. Dropping ne is informal speech. In formal emails, contracts, letters = ne is always present. This is a CLB 5-6 register marker!"),
     wr("Write an 80-word email requesting a meeting to discuss your immigration file",["je vous écris afin de","je souhaiterais","pourriez-vous","à votre convenance","dans l'attente","cordialement"],"Bonjour Madame/Monsieur, Je vous écris afin de vous demander si vous pourriez me recevoir en rendez-vous pour discuter de mon dossier d'immigration. En effet, j'ai reçu une demande de documents supplémentaires et j'aimerais obtenir des clarifications à ce sujet. Je suis disponible du lundi au vendredi, à votre convenance. Dans l'attente de votre réponse, je vous adresse mes cordiales salutations. [Nom]. — ~80 words!")]),

  mkL("clb-10","CLB 6 Listening: Extended Dialogue",25,"listening",
    "CLB 6 listening: understand extended dialogues (5-8 minutes) between 2-3 speakers on a substantive topic. New challenges: speakers may interrupt each other, use informal language, express opinions (not just facts), and disagree. You must track: who says what, who agrees/disagrees, the progression of the discussion, and the conclusion reached (or not). Radio-Canada debates and Panel discussions are excellent practice for CLB 6!",
    ["CLB 6: dialogues étendus 5-8 minutes","2-3 locuteurs, parfois en désaccord","Suivre: qui dit quoi, qui s'oppose à qui","Progression de la discussion","Conclusion atteinte ou non?","Radio-Canada: Les grandes gueules, Tout le monde en parle","Comprendre langage informel en contexte","Inférer les attitudes (enthousiaste? sceptique? neutre?)"],
    [mcq("In a CLB 6 listening task with multiple speakers, your priority is:",["understand every word of every speaker","track who holds which position and how the discussion evolves","only focus on the final conclusion","only listen to the host/moderator"],1,"Track positions + evolution. Who: A disagrees with B on X, C agrees with A about Y. How it evolves: initially opposed, then... What conclusion (if any). This map of positions and evolution = CLB 6 extended dialogue comprehension!"),
     li("Premier interlocuteur : Moi, je trouve que le nouveau projet est emballant, on devrait foncer tout de suite! Deuxième interlocuteur : Je comprends ton enthousiasme, mais soyons prudents. Nous n'avons pas encore évalué les coûts ni les risques. Précipiter les choses pourrait nous coûter cher.","Quelle est l'attitude du deuxième interlocuteur?",["Prudent : il tempère l'enthousiasme du premier","Tout aussi enthousiaste que le premier","Totalement opposé au projet","Indifférent à la discussion"],0,"The second speaker isn't against the project — he's cautious. « Je comprends ton enthousiasme, mais soyons prudents… » signals tempering, not rejection. Inferring attitudes (enthusiastic vs cautious vs opposed) is CLB 6 listening.",{diff:3}),
     wr("After listening to a debate, write a 2-sentence summary of positions",["le premier interlocuteur pense","le deuxième estime","l'un affirme que","l'autre soutient que","ils sont en désaccord sur"],"Le premier interlocuteur affirme que l'immigration est bénéfique pour l'économie canadienne, en citant notamment les secteurs en pénurie de main-d'œuvre. Le second estime que l'intégration linguistique doit être prioritaire et que les ressources actuelles sont insuffisantes. — Positions clearly distinguished = CLB 6 listening comprehension!")]),

  mkL("clb-11","CLB 6 Speaking: Justify & Persuade",25,"speaking",
    "CLB 6 speaking: persuade and justify — go beyond opinion to actively convince! The difference from CLB 5: at CLB 5 you express and justify your opinion. At CLB 6, you anticipate objections, address counter-arguments, use rhetorical strategies (rhetorical questions, vivid examples, appeal to shared values). Language: 'Il est indéniable que...', 'N'est-il pas vrai que...?', 'Comme nous le savons tous...', 'Force est de reconnaître que...'",
    ["CLB 6 = persuader activement","Anticiper les objections","Réfuter les contre-arguments","Questions rhétoriques: 'N'est-il pas évident que...?'","Appel aux valeurs communes","Exemples concrets et frappants","'Il est indéniable que...'","'Comme en témoignent les faits...'","Conclure par un appel à l'action"],
    [mcq("A rhetorical question in persuasive speaking:",["requires an answer from the audience","is used to make a statement feel like an obvious conclusion","is a genuine request for information","signals the end of the argument"],1,"A rhetorical question doesn't require an answer — it's stated as if the answer is obvious, drawing the listener to agree. 'N'est-il pas évident que l'apprentissage du français enrichit votre vie au Canada?' implies: of course it does! Powerful persuasive device in French discourse."),
     sp("Persuade your listener (~2 min) that « apprendre le français est un atout, même en dehors du Québec ». Anticipate an objection, refute it, use a rhetorical question, and appeal to shared Canadian values.","Il est indéniable que le français est un atout, même en dehors du Québec. Certes, on pourrait objecter que l'anglais suffit dans la plupart des provinces. Cependant, n'est-il pas évident que maîtriser les deux langues officielles du Canada multiplie les possibilités d'emploi, notamment dans la fonction publique fédérale? Comme nous le savons tous, le bilinguisme est au cœur de l'identité canadienne. C'est pourquoi j'invite chacun à persévérer dans son apprentissage.",["il est indéniable que","certes","n'est-il pas","cependant","c'est pourquoi"],"CLB 6 persuasion: anticipate the objection ('on pourrait objecter'), refute it, deploy a rhetorical question, and appeal to shared values. You're actively convincing, not just stating an opinion."),
     wr("Write a persuasive sentence addressing someone who thinks French is too hard to learn",["certes, le français peut paraître","cependant, des milliers d'immigrants","la preuve en est que","n'est-il pas vrai que","il est indéniable que"],"Certes, le français peut paraître complexe au premier abord. Cependant, des milliers d'immigrants réussissent à le maîtriser chaque année — la preuve en est que vous lisez ces mots en français en ce moment même! N'est-il pas encourageant de constater que vous progressez déjà? — Concession + evidence + rhetorical question = CLB 6 persuasion!")]),

  mkL("clb-12","CLB 6 Reading: Analyse a Text",25,"reading",
    "CLB 6 reading: go beyond comprehension to ANALYSIS. You must: identify the author's purpose (informer, persuader, critiquer, comparer), recognize stylistic choices (tone, examples, structure), evaluate the quality of arguments (well-supported? one-sided?), and detect implicit messages or assumptions. Text types: editorial, analytical essay, formal report, policy analysis. This is the level of reading required for professional and academic success in French Canada.",
    ["CLB 6 lecture = analyse, pas seulement compréhension","But de l'auteur: informer, persuader, critiquer","Ton: neutre, engagé, ironique, alarmiste","Qualité des arguments: bien étayés? partiaux?","Messages implicites et présupposés","Registre et vocabulaire révèlent le positionnement","Structure: thèse, développement, conclusion","À qui ce texte est-il destiné?"],
    [mcq("An analytical reading question 'What is the author's implicit assumption?' asks you to:",["find a direct quote from the text","identify something the author assumes without stating it","summarize the main point","count the paragraphs"],1,"Implicit assumption = something the author takes for granted without stating it. 'L'apprentissage du français est indispensable pour les immigrants' assumes that integration is a priority value. A critical reader asks: why assume this? For whom? This is CLB 6+ critical reading!"),
     rd("Face à l'inaction du gouvernement en matière de logement, il devient urgent d'agir. Chaque mois, des centaines de familles québécoises se retrouvent sans toit, tandis que les loyers atteignent des sommets jamais vus. Les belles promesses ne suffisent plus : ce sont des mesures concrètes et immédiates que réclament les citoyens. Combien de temps encore faudra-t-il attendre?","Quel est le ton de ce texte, et son but?",["Engagé et alarmiste : il vise à pousser à l'action","Neutre et objectif : il informe seulement","Ironique : il se moque du sujet","Humoristique : il cherche surtout à divertir"],0,"Analyse, not just comprehension. Charged words ('inaction', 'sans toit', 'sommets jamais vus') plus the closing rhetorical question and the call for 'mesures concrètes et immédiates' mark an engaged, alarmist editorial meant to mobilize — not neutral reporting.",{title:"Éditorial — La Presse",glossary:[["l'inaction","inaction"],["sans toit","homeless"],["réclamer","to demand"]],diff:4}),
     wr("Identify the tone of this sentence: 'Face à l'inaction scandaleuse du gouvernement, les citoyens n'ont d'autre choix que de se mobiliser.'",["neutre et objectif","alarmiste et engagé (calls for action, emotional vocabulary)","ironique","informatif seulement"],"Alarmiste et engagé! 'Inaction scandaleuse' (outrageous inaction — emotional), 'n'ont d'autre choix' (have no choice — urgency). The author is clearly taking sides and trying to mobilize readers. This is NOT neutral reporting — it's an engaged editorial voice. CLB 6 critical reading!")]),

  mkL("clb-13","CLB 6 Writing: Opinion Paragraph (120 words)",30,"writing",
    "CLB 6 writing: a well-developed opinion paragraph of 120 words with sophisticated language. What makes CLB 6 different from CLB 5? More words (120 vs 80), more complex connectors (de surcroît, en revanche, force est de constater), richer vocabulary (not just 'important' but 'déterminant, fondamental, incontournable'), longer and more varied sentence structures, and a concession that shows genuine engagement with the topic. Aim for: 4-5 sentences, varied length, logical flow.",
    ["CLB 6: ~120 mots avec sophistication","Vocabulaire riche et précis (pas de répétitions)","Connecteurs avancés: de surcroît, en revanche, à cet égard","Structures variées: courtes + longues","Concession REQUISE au CLB 6","Pas de répétition des mêmes mots","Orthographe et accents parfaits","4-5 phrases avec fluidité logique"],
    [mcq("What makes a CLB 6 paragraph different from CLB 5?",["it's just longer","it has more sophisticated vocabulary, complex structures, and a required concession","it uses more examples only","it avoids opinions"],1,"CLB 6 = sophistication + concession required. Not just longer — BETTER: richer vocab, varied structures, logical connectors, genuine engagement with counter-arguments. A CLB 5 paragraph expanded to 120 words without these features is still CLB 5, not CLB 6!"),
     mcq("In CLB 6 writing, repeating 'important' 3 times in one paragraph shows:",["emphasis","lack of vocabulary range (a CLB 6 weakness)","strong argument","good organization"],1,"Vocabulary range is assessed! Synonyms of 'important': crucial, fondamental, déterminant, incontournable, primordial, essentiel, capital. Using only one adjective = limited vocabulary range = CLB 5 or below. Vary your vocabulary deliberately!"),
     wr("Write a 120-word opinion on the importance of learning French in Canada (with concession)",["à mon sens","il est indéniable que","de surcroît","certes","en revanche","force est de constater","à cet égard"],"À mon sens, l'apprentissage du français constitue un enjeu fondamental pour quiconque souhaite s'intégrer pleinement à la société canadienne, particulièrement au Québec. En effet, maîtriser la langue officielle de la province ouvre des portes considérables sur le plan professionnel et social. De surcroît, cela témoigne d'un respect profond pour la culture et l'identité francophone. Certes, l'apprentissage d'une nouvelle langue représente un défi considérable, notamment pour les adultes. En revanche, les bénéfices à long terme — tant sur le plan personnel que professionnel — justifient amplement cet investissement. Force est de constater que ceux qui maîtrisent le français progressent plus rapidement dans leur intégration. (~120 words!)")]),

  mkL("clb-14","CLB 7 Listening: Complex Audio",30,"listening",
    "CLB 7 listening: handle complex audio with academic or professional content. Types: panel discussions, interviews with experts, conference recordings, news analyses. Characteristics: fast natural speech, multiple complex ideas, implicit references, domain-specific vocabulary. You must follow the full logic of complex arguments, track the development of ideas across 5-10 minutes, and understand both explicit content AND implied meaning. Daily practice with Radio-Canada (Ici Radio-Canada, ICI TOU.TV) = essential!",
    ["CLB 7: audio complexe, 5-10 minutes","Discours rapide, naturel, avec chevauchements","Contenu académique ou professionnel","Vocabulaire spécialisé en contexte","Suivre la logique d'un argument complexe","Comprendre l'implicite et les allusions","Pratique: Ici Radio-Canada, RDI, balados","CLB 7 ≈ compréhension de 85-90% en contexte naturel"],
    [mcq("At CLB 7, your listening comprehension of authentic French content should be:",["50% — just catch main ideas","70% — some parts unclear","85-90% — can follow complex discussions with occasional unclear parts","100% — every word understood"],2,"85-90% = CLB 7 listening. You can follow complex discussions, understand 85-90% of content, and reconstruct meaning from context for the 10-15% you miss. Perfect 100% comprehension is not the target — native speakers don't achieve 100% in all contexts either!"),
     li("Malgré les investissements considérables annoncés par le gouvernement l'an dernier, force est de constater que les délais d'attente dans le réseau de la santé n'ont guère diminué. Certains experts y voient désormais un problème structurel, plutôt qu'un simple manque de financement.","Que sous-entend le passage au sujet des investissements?",["Ils n'ont pas vraiment réglé le problème des délais d'attente","Ils ont complètement éliminé les délais d'attente","Le gouvernement n'a rien investi du tout","Les experts approuvent pleinement la stratégie actuelle"],0,"This tests l'implicite. « Malgré les investissements… force est de constater que les délais n'ont guère diminué » implies the money didn't fix the problem — without saying so directly. 'Guère' = hardly. Catching this implied critique is exactly CLB 7 listening.",{once:true,diff:4,transcriptEn:"Despite the considerable investments announced by the government last year, it must be acknowledged that wait times in the health network have hardly decreased. Some experts now see this as a structural problem rather than a simple lack of funding."}),
     wr("Name 2 Radio-Canada programs you'll use for CLB 7 listening practice",["le téléjournal","les coulisses du pouvoir","tout le monde en parle","c'est encore mieux l'après-midi","les années lumière","ici première","rdi"],"Le Téléjournal (evening news — clear French, current affairs) + Tout le monde en parle (Sunday talk show — fast, informal, multiple speakers = challenging CLB 7 practice!). Les Coulisses du pouvoir (political analysis) is also excellent for academic/political vocabulary!")]),

  mkL("clb-15","CLB 7 Speaking: 3-Minute Monologue",30,"speaking",
    "CLB 7 speaking: a 3-minute sustained, organized monologue on a complex topic! At CLB 7, you are expected to: speak fluently without long pauses, use a range of complex structures (subjunctive, conditional perfect, nominalization), vary your vocabulary throughout (no repetition), demonstrate awareness of both sides of an issue, and draw a nuanced conclusion. This is professional-level French communication — the standard required for many Canadian workplaces and government positions.",
    ["3 minutes soutenues sans longues pauses","Structures complexes: subjonctif, cond. passé, nomi.","Vocabulaire varié tout au long (pas de répétition)","Conscience des deux côtés: concession forte","Conclusion nuancée (pas simpliste)","Rythme: modéré, articulé, assuré","Niveau professionnel et académique","CLB 7 = employabilité dans la plupart des secteurs"],
    [mcq("At CLB 7, the 3-minute monologue is distinguished by:",["the length alone","fluency, complexity, vocabulary range, and nuanced argumentation working together","using only simple sentences","having no errors at all"],1,"All elements working together = CLB 7. Fluency (no long pauses) + complexity (varied structures) + vocabulary range + nuance (sees both sides) + organized argument. It's not about perfection — it's about consistent B2-level production across 3 minutes!"),
     sp("Deliver a sustained monologue (aim for 2–3 minutes) on « L'immigration est-elle bénéfique pour le Canada? ». Structure: contextualize → argument 1 + données → argument 2 + exemple → concession forte → conclusion nuancée. Vary your connectors and vocabulary.","Le Canada est, depuis sa fondation, une terre d'immigration. À mon sens, l'immigration demeure bénéfique pour le pays. D'abord, sur le plan économique, elle comble des pénuries de main-d'œuvre dans des secteurs essentiels comme la santé. De surcroît, elle enrichit la diversité culturelle qui fait la réputation du Canada. Certes, une intégration mal encadrée peut engendrer des tensions ; cependant, des politiques d'accueil adéquates atténuent ces difficultés. En conclusion, bien que des défis subsistent, force est de constater que les bénéfices l'emportent largement.",["immigration","sur le plan économique","de surcroît","certes","cependant","en conclusion","force est de constater"],"A CLB 7 monologue weaves fluency, complex structures, varied vocabulary, a real concession, and a nuanced conclusion together over 2–3 minutes. The model is your target — make it your own."),
     wr("Write the conclusion sentence of a CLB 7 monologue on Canadian identity",["en conclusion","il demeure que","bien que","malgré les défis","au final","force est de constater","la richesse de"],"En conclusion, bien que la définition de l'identité canadienne soit un sujet complexe et en constante évolution, force est de constater que sa richesse réside précisément dans cette diversité linguistique, culturelle et régionale qui la constitue. — Complex, nuanced, maintains a position without oversimplifying. CLB 7 conclusion!")]),

  mkL("clb-16","CLB 7 Reading: Critical Reading",25,"reading",
    "CLB 7 reading: analyze complex texts from multiple perspectives, evaluate the quality of evidence, identify rhetorical strategies, and form your own critical response. At this level you read: policy documents, academic articles, complex journalism, literature (in context). You can: distinguish between different types of evidence (anecdote vs data vs expert opinion), evaluate credibility, identify logical fallacies (generalization, false dichotomy), and appreciate stylistic choices.",
    ["CLB 7: analyse critique multi-perspectives","Types de preuves: anecdote, données, opinion experte","Évaluer la crédibilité des sources","Identifier les sophismes: généralisation, faux dilemme","Stratégies rhétoriques: pathos, logos, éthos","Style littéraire: ironie, hyperbole, euphémisme","Former sa propre réponse critique","CLB 7 lecture = niveau professionnel et académique"],
    [mcq("'Tous les immigrants veulent s'isoler de la société d'accueil' is an example of:",["a valid generalization","an anecdote","a logical fallacy (overgeneralization)","an expert opinion"],2,"Overgeneralization = logical fallacy. 'Tous les immigrants' with a single sweeping negative claim ignores enormous diversity of individual experiences and research. Critical readers at CLB 7 identify these fallacies and ask: 'How do you know? For all? Always? Is this supported by evidence?'"),
     rd("Il est de bon ton, dans certains milieux, d'affirmer que l'immigration menace la cohésion sociale. Or, les données disponibles racontent une tout autre histoire : les régions qui accueillent le plus de nouveaux arrivants affichent souvent une croissance économique supérieure à la moyenne. Faut-il pour autant nier les défis d'intégration? Certainement pas. Mais réduire un phénomène aussi complexe à une simple menace relève davantage de la rhétorique de la peur que de l'analyse rigoureuse.","Quelle est l'attitude de l'auteur envers l'idée que « l'immigration menace la cohésion sociale »?",["Il la conteste en s'appuyant sur des données, tout en reconnaissant les défis","Il l'approuve entièrement","Il l'ignore et change de sujet","Il affirme qu'il n'y a aucun défi d'intégration"],0,"Critical reading: the author rejects the claim ('Or, les données… racontent une tout autre histoire') using data (logos), concedes the challenges ('Faut-il nier les défis? Certainement pas'), and labels the opposing view 'la rhétorique de la peur'. Spotting that balance — rebuttal + concession + critique of the opponent's method — is CLB 7.",{title:"Chronique — Le Devoir",glossary:[["il est de bon ton","it's fashionable"],["or","yet / now (contrast)"],["relever de","to be a matter of"]],diff:4}),
     wr("Identify one rhetorical strategy in this text: 'Des milliers d'immigrants, laissés à eux-mêmes, souffrent en silence dans nos villes.'",["pathos — image émotionnelle","vocabulaire émotionnel","appel aux émotions","la souffrance est un appel émotionnel"],"Pathos — 'souffrent en silence' is emotionally charged language designed to create empathy and urgency. The image of thousands suffering silently in 'our cities' (creating shared responsibility) is an emotional appeal meant to move the reader to action, not a logical argument based on data. CLB 7 rhetorical awareness!")]),

  mkL("clb-17","CLB 7 Writing: Essay (200 words)",35,"writing",
    "CLB 7 writing: a fully developed 200-word essay on a complex topic. This is the TEF Canada expression écrite standard! Requirements: sophisticated introduction with clear thesis, two well-developed arguments with evidence, a genuine concession, a strong conclusion with broader perspective. Language: varied and sophisticated vocabulary, complex sentence structures, precise and varied connectors, flawless spelling (including all accents), consistent formal register. No errors in basic grammar — errors only in complex structures (CLB 7 tolerance).",
    ["200 mots précisément (190-220 acceptable)","Introduction: contexte + thèse claire","Argument 1: développé avec preuve","Argument 2: développé avec preuve","Concession réelle: reconnaître l'autre côté","Conclusion: thèse + perspective plus large","Zéro erreur en grammaire de base","Orthographe parfaite (accents inclus!)","Connecteurs variés et précis","Registre formel maintenu sur 200 mots"],
    [mcq("At CLB 7, the 200-word essay should have how many main arguments?",["5-6 quick points","1 argument very long","2 well-developed arguments + concession","only a concession and conclusion"],2,"2 developed arguments + concession = the CLB 7 essay structure. 'Developed' means: state the argument + explain why + give a specific example or evidence. Two thin, undeveloped arguments score worse than one truly developed one!"),
     mcq("In a CLB 7 essay, spelling errors:",["are completely acceptable","only affect the vocabulary score","affect both the language score and create a negative impression overall","are ignored if the content is good"],2,"Every spelling error (including missing accents) signals lower competency. At CLB 7, basic spelling must be flawless. Complex words may have occasional errors — acceptable. But common errors (pas d'accent, 'il a' vs 'il à') are CLB 5-6 markers. Proofread systematically!"),
     wr("Write a 200-word essay introduction + first argument on 'Le français comme langue d'intégration au Canada'",["dans un contexte","à l'heure où","force est de constater","il est indéniable que","en premier lieu","comme en témoignent"],"À l'heure où le Canada accueille un nombre record d'immigrants chaque année, la question de l'intégration linguistique s'impose comme un enjeu fondamental. Je soutiens que la maîtrise du français constitue, particulièrement au Québec, le vecteur principal d'une intégration réussie. En premier lieu, les données du marché du travail québécois attestent sans équivoque que les immigrants maîtrisant le français accèdent à de meilleures opportunités professionnelles. Comme en témoignent les statistiques de l'OQLF, les francophones au Québec affichent un taux d'emploi significativement supérieur dans les secteurs les mieux rémunérés. (~120 words for intro + arg 1 = on track for 200!)")]),

  mkL("clb-18","TEF Canada: Full Test Simulation",35,"integrated",
    "Complete TEF Canada simulation — full test experience in one session! Review: TEF Canada measures your French for immigration and professional recognition in Canada. The 4 sections: compréhension orale (listening), expression orale (speaking), compréhension écrite (reading), expression écrite (writing). Your LOWEST section score determines your CLB level for most immigration purposes. Therefore: work on your WEAKEST skill — it's what limits your overall CLB score!",
    ["TEF Canada: 4 épreuves","La plus faible détermine votre niveau CLB global!","S'inscrire: CCFL (Centre canadien de français langue)","Lieu: centres de test désignés (Montréal, Québec, etc.)","Résultats: 3 semaines après l'examen","Validité: 2 ans (vérifier avec IRCC)","Frais: environ 350-400$ selon l'épreuve","Préparation: simulations régulières + Radio-Canada"],
    [mcq("For immigration purposes, your CLB level is determined by:",["your highest scoring section","your average score across all 4 sections","your lowest scoring section","your speaking score only"],2,"Your LOWEST section = your overall CLB level for immigration. This is crucial! If you score CLB 8 in listening, reading, and writing, but CLB 5 in speaking — you are CLB 5 for immigration purposes. FOCUS YOUR STUDY ON YOUR WEAKEST SKILL!"),
     mcq("The TEF Canada test should be taken:",["as far in advance as possible regardless of preparation","3-6 months before you need the results, after adequate preparation","on the day of your immigration application","only once in your lifetime"],1,"3-6 months before needed — allow time for: registration (sometimes 4-6 weeks wait), 3-week result delay, and potential retake if needed. Don't book TEF too early (results expire in 2 years!) or too late (no retake time if you need to improve). Planning is key!"),
     wr("Write your pre-TEF Canada checklist (5 items)",["pièce d'identité valide","confirmations d'inscription","se reposer","eau et collation si permis","arriver en avance","calculer le trajet"],"1) Pièce d'identité valide + confirmation d'inscription. 2) Bonne nuit de sommeil la veille. 3) Arriver 30 min en avance. 4) Matériel permis: crayons, gomme (calculatrice si autorisée). 5) Attitude positive — vous avez préparé et vous êtes prêt(e)! Bonne chance!")]),

  mkL("clb-19","CLB Progress Assessment",25,"integrated",
    "Comprehensive CLB progress check — where are you now? Use this lesson to assess your current CLB level across all 4 skills. Self-assessment questions: 1) Can you understand most of a Radio-Canada news broadcast? (CLB 6-7 listening). 2) Can you speak for 2 minutes on any topic without major pauses? (CLB 5-6 speaking). 3) Can you read a Le Devoir article and understand 80%+? (CLB 6-7 reading). 4) Can you write a formal 120-word email without major errors? (CLB 5-6 writing).",
    ["Auto-évaluation: 4 compétences","Compréhension orale: écouter Radio-Canada sans sous-titres","Expression orale: 2 min sans pauses longues","Compréhension écrite: lire Le Devoir à 80%+","Expression écrite: courriel 120 mots sans erreurs majeures","Identifier: compétence la plus forte / la plus faible","Plan: concentrer les efforts sur la compétence faible","CLB 5 = employable dans la plupart des secteurs au Canada"],
    [mcq("If your speaking is CLB 6 but your writing is CLB 4, for immigration you are at:",["CLB 6","CLB 5 (average)","CLB 4 (weakest skill determines level)","CLB 6 writing can compensate"],2,"CLB 4 — the weakest skill determines your immigration CLB level. This means: study writing intensively! One month of daily writing practice can move CLB 4 → CLB 5. Focus here — it's limiting your overall level!"),
     mcq("'Employable in most sectors in Canada' roughly corresponds to:",["CLB 3","CLB 4","CLB 5-6","CLB 9-10"],2,"CLB 5-6 = functional for most Canadian workplaces. Many employers accept CLB 5 minimum. Healthcare (nurses, doctors) often requires CLB 7-8. Government positions may require CLB 6-8 depending on role. CLB 5 is the key immigration/employment threshold!"),
     wr("Write your honest current CLB self-assessment",["ma compétence orale est au niveau","ma compréhension écrite est","mon expression écrite est","ma compréhension orale est","mon niveau global estimé est"],"Compréhension orale: CLB [X] — Expression orale: CLB [X] — Compréhension écrite: CLB [X] — Expression écrite: CLB [X]. Niveau global estimé: CLB [weakest]. Plan d'amélioration: [specific area]. Honest self-assessment is the foundation of effective language learning. No shame in identifying weaknesses — it's how you grow!")]),

  mkL("clb-20","CLB Final Readiness Check & Next Steps",25,"integrated",
    "FINAL FRANCO LESSON — CLB readiness check and your path forward! You've completed 190 lessons across Foundation through CLB Test Prep. This is an extraordinary achievement. Now: 1) Take a full TEF Canada practice test and score yourself. 2) If CLB 5+: consider registering for TEF Canada. 3) If CLB 4: continue with B1 Franco content, daily Radio-Canada, and writing practice. Remember: language is not a destination — it's a daily practice. Félicitations pour votre parcours extraordinaire!",
    ["190 leçons Franco complétées — extraordinaire!","Tester: simulation TEF complète","CLB 5+: prêt(e) pour l'inscription au TEF Canada","CLB 4: continuer B1 + pratique quotidienne","Ressources à long terme: Radio-Canada, Le Devoir","Pratique quotidienne: même 15 minutes = progrès","La langue = pratique, pas destination","Communautés francophones à rejoindre au Canada","Cours de francisation gratuits (si éligible)"],
    [mcq("After completing the Franco program, the single most important habit is:",["reviewing all 190 lessons repeatedly","taking the TEF exam immediately","daily French practice in authentic contexts","studying grammar books"],2,"DAILY AUTHENTIC PRACTICE! Listen to Radio-Canada while cooking. Read La Presse headlines with coffee. Write one journal entry per week. Speak with francophone neighbours or colleagues. 15 minutes of authentic French daily > 2 hours of formal study once a week. Immersion in Canadian francophone life = true fluency!"),
     mcq("Free French courses (cours de francisation) in Quebec are available to:",["all Canadians","only permanent residents","newcomers with temporary or permanent status (immigrants)","only citizens"],2,"Cours de francisation gratuits = free for eligible newcomers (mostly permanent residents and some temporary residents). Offered by: MICC (Ministère de l'Immigration du Québec), school boards (commissions scolaires), CLSCs, community organizations. FULL-TIME options allow faster progress — check your eligibility!"),
     wr("Write your final message to yourself after completing Franco",["j'ai accompli","je suis fier(e) de","mon voyage linguistique","je continuerai","le français est maintenant","ma vie au canada"],"J'ai accompli quelque chose d'extraordinaire en complétant le programme Franco. Le français, qui était un obstacle, est maintenant un atout et une source de fierté. Je continuerai à pratiquer chaque jour, à m'intégrer dans ma communauté francophone, et à viser l'excellence. Mon parcours linguistique au Canada ne fait que commencer. Félicitations à moi! 🇨🇦🎉 — You've earned this. Félicitations!")])

];

// ─────────────────────────────────────────────────────────────────────────────
// ASSEMBLE FULL SYLLABUS
// ─────────────────────────────────────────────────────────────────────────────
const SYLLABUS = {
  foundation:{
    id:"foundation",label:"Foundation",emoji:"🌱",color:T.mint,
    desc:"Zero French → survival phrases, sounds, numbers, greetings, basic vocabulary",
    cefrTag:"Pre-A1",clbTag:"Pre-CLB",
    modules:[
      {id:"f1",title:"📣 Sounds & Pronunciation",lessons:FOUNDATION_LESSONS.slice(0,4)},
      {id:"f2",title:"👋 Greetings & Introductions",lessons:FOUNDATION_LESSONS.slice(4,8)},
      {id:"f3",title:"🙏 Politeness & Survival",lessons:FOUNDATION_LESSONS.slice(8,12)},
      {id:"f4",title:"🏠 Basic Vocabulary",lessons:FOUNDATION_LESSONS.slice(12,16)},
      {id:"f5",title:"🛍️ Shopping & Numbers",lessons:FOUNDATION_LESSONS.slice(16,20)},
    ]
  },
  a1:{
    id:"a1",label:"A1 — Beginner",emoji:"🔤",color:T.blue,
    desc:"Core grammar, 1000 key words, handle daily situations in Canada",
    cefrTag:"CEFR A1",clbTag:"CLB 1–2",
    modules:[
      {id:"a1m1",title:"⚙️ Core Grammar",lessons:A1_LESSONS.slice(0,8)},
      {id:"a1m2",title:"📚 Grammar Expansion",lessons:A1_LESSONS.slice(8,16)},
      {id:"a1m3",title:"🍽️ Daily Life Vocabulary",lessons:A1_LESSONS.slice(16,24)},
      {id:"a1m4",title:"🏥 Services & Work",lessons:A1_LESSONS.slice(24,32)},
      {id:"a1m5",title:"📝 A1 Practice & Assessment",lessons:A1_LESSONS.slice(32,40)},
    ]
  },
  a2:{
    id:"a2",label:"A2 — Elementary",emoji:"📖",color:T.purple,
    desc:"Past & future tenses, functional writing, CLB 4 readiness",
    cefrTag:"CEFR A2",clbTag:"CLB 3–4",
    modules:[
      {id:"a2m1",title:"⏪ Past Tenses",lessons:A2_LESSONS.slice(0,4)},
      {id:"a2m2",title:"⏩ Future & Conditional",lessons:A2_LESSONS.slice(4,8)},
      {id:"a2m3",title:"🔗 Pronouns & Clauses",lessons:A2_LESSONS.slice(8,12)},
      {id:"a2m4",title:"🇨🇦 Canadian Life Vocabulary",lessons:A2_LESSONS.slice(12,20)},
      {id:"a2m5",title:"📝 A2 Skills Practice",lessons:A2_LESSONS.slice(20,30)},
      {id:"a2m6",title:"🎯 A2 Assessment",lessons:A2_LESSONS.slice(30,40)},
    ]
  },
  b1:{
    id:"b1",label:"B1 — Intermediate",emoji:"💬",color:T.gold,
    desc:"Express opinions, professional French, CLB 5–6 performance",
    cefrTag:"CEFR B1",clbTag:"CLB 5–6",
    modules:[
      {id:"b1m1",title:"🗣️ Opinions & Argumentation",lessons:B1_LESSONS.slice(0,6)},
      {id:"b1m2",title:"📝 Professional Writing",lessons:B1_LESSONS.slice(6,12)},
      {id:"b1m3",title:"⚙️ Advanced Grammar",lessons:B1_LESSONS.slice(12,20)},
      {id:"b1m4",title:"🇨🇦 B1 Vocabulary",lessons:B1_LESSONS.slice(20,28)},
      {id:"b1m5",title:"🎯 CLB 5-6 Assessment",lessons:B1_LESSONS.slice(28,40)},
    ]
  },
  b2:{
    id:"b2",label:"B2 — Upper Intermediate",emoji:"🎓",color:"#DC2626",
    desc:"Advanced fluency, nuance, TEF Canada preparation, CLB 7–8",
    cefrTag:"CEFR B2",clbTag:"CLB 7–8",
    modules:[
      {id:"b2m1",title:"⚙️ Advanced Grammar",lessons:B2_LESSONS.slice(0,6)},
      {id:"b2m2",title:"📝 Academic Writing",lessons:B2_LESSONS.slice(6,14)},
      {id:"b2m3",title:"📋 TEF Canada Prep",lessons:B2_LESSONS.slice(14,22)},
      {id:"b2m4",title:"🎯 B2 Assessment",lessons:B2_LESSONS.slice(22,30)},
    ]
  },
  clb:{
    id:"clb",label:"CLB Test Prep",emoji:"🏅",color:"#059669",
    desc:"Targeted Canadian Language Benchmark preparation — all 4 skills, all levels",
    cefrTag:"CLB 3–7",clbTag:"Test Ready",
    modules:[
      {id:"clbm1",title:"📋 CLB System & Strategy",lessons:CLB_LESSONS.slice(0,5)},
      {id:"clbm2",title:"🎧 CLB Listening",lessons:CLB_LESSONS.slice(5,9)},
      {id:"clbm3",title:"🗣️ CLB Speaking",lessons:CLB_LESSONS.slice(9,13)},
      {id:"clbm4",title:"📖 CLB Reading & Writing",lessons:CLB_LESSONS.slice(13,17)},
      {id:"clbm5",title:"🎯 CLB Final Simulation",lessons:CLB_LESSONS.slice(17,20)},
    ]
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// QUESTION HELPERS — 6 types, difficulty tagged
// type: "tap" = tap the translation (easiest, Foundation)
// type: "mcq" = 4-option multiple choice
// type: "fill" = fill in the blank with word bank
// type: "order" = drag words into correct order
// type: "write" = free-text write (intermediate)
// type: "speak" = speaking challenge prompt (advanced)

const COMPANIONS = [
  {
    id:"sophie", name:"Sophie", emoji:"👩‍🏫", color:"#1A56DB", level:"All levels",
    messages:{
      idle:"Prêt à apprendre? Let's go! 🇨🇦",
      correct:"Parfait! Excellent work! 🌟",
      wrong:"Pas de problème! Let's try again 💪",
      complete:"Félicitations! Lesson complete! 🎉",
    }
  },
  {
    id:"marc", name:"Marc", emoji:"👨‍🎓", color:"#059669", level:"All levels",
    messages:{
      idle:"Bonjour! Ready to practice? 📚",
      correct:"Très bien! Keep it up! ✨",
      wrong:"Presque! Almost there 🔥",
      complete:"Bravo! You crushed it! 🏆",
    }
  },
  {
    id:"amelie", name:"Amélie", emoji:"👩‍💼", color:"#8B5CF6", level:"All levels",
    messages:{
      idle:"Allons-y! Let's make progress! 🚀",
      correct:"Magnifique! You're on fire! 🔥",
      wrong:"Courage! Mistakes help us learn 🧠",
      complete:"Incroyable! You did it! 🌟",
    }
  },
];

const GAMES = [
  {
    id:"speed", emoji:"⚡", name:"Speed Recall",
    desc:"60 seconds. Translate French → English as fast as you can. Beat your high score!",
    color:T.blue, tag:"60 sec",
    questions:[
      {fr:"Bonjour",en:"Hello / Good day"},{fr:"Merci beaucoup",en:"Thank you very much"},
      {fr:"Je voudrais...",en:"I would like..."},{fr:"Où est...?",en:"Where is...?"},
      {fr:"Au revoir",en:"Goodbye"},{fr:"S'il vous plaît",en:"Please"},
      {fr:"Je ne comprends pas",en:"I don't understand"},{fr:"C'est combien?",en:"How much?"},
      {fr:"Mon rendez-vous",en:"My appointment"},{fr:"Je prends le bus",en:"I take the bus"},
      {fr:"J'habite à...",en:"I live in..."},{fr:"J'ai besoin de",en:"I need"},
      {fr:"Excusez-moi",en:"Excuse me"},{fr:"De rien",en:"You're welcome"},
      {fr:"Il fait froid",en:"It's cold"},{fr:"Je me lève",en:"I get up"},
      {fr:"À quelle heure?",en:"At what time?"},{fr:"À bientôt",en:"See you soon"},
      {fr:"J'ai faim",en:"I'm hungry"},{fr:"Bonne journée!",en:"Have a good day!"},
      {fr:"Je travaille",en:"I work"},{fr:"Je cherche",en:"I'm looking for"},
      {fr:"C'est urgent",en:"It's urgent"},{fr:"Pouvez-vous répéter?",en:"Can you repeat?"},
      {fr:"La pharmacie",en:"The pharmacy"},{fr:"Mon médecin",en:"My doctor"},
    ]
  },
  {
    id:"errors", emoji:"🧩", name:"Error Hunter",
    desc:"Find the correct sentence. Spot the grammar mistake before it catches you in real life!",
    color:T.mint, tag:"Grammar",
    questions:[
      {prompt:"Age in French — which is correct?",answer:"J'ai 28 ans ✓",wrong:"Je suis 28 ans ✗",explain:"French uses AVOIR for age! J'ai (I have) 28 ans. Never 'Je suis 28 ans' — one of the most common errors!"},
      {prompt:"After negation — which is correct?",answer:"Je n'ai pas de voiture ✓",wrong:"Je n'ai pas une voiture ✗",explain:"After ne...pas: un/une/des → DE. Je n'ai pas DE voiture. Always!"},
      {prompt:"Female speaker, passé composé — which is correct?",answer:"Je suis allée au marché ✓",wrong:"Je suis allé au marché ✗",explain:"With être, past participle agrees with subject! Female → allée (add E). Male → allé."},
      {prompt:"Polite request — which is more appropriate?",answer:"Je voudrais un café, s'il vous plaît ✓",wrong:"Je veux un café ✗",explain:"'Voudrais' (conditional) = polite request. 'Veux' sounds too direct in service situations!"},
      {prompt:"Email opening — which is correct?",answer:"Bonjour Madame Tremblay, ✓",wrong:"Salut Madame Tremblay, ✗",explain:"'Salut' is informal — friends only! Formal emails always use 'Bonjour + title + name'. Never Salut with professionals!"},
      {prompt:"Auxiliary verb — which is correct?",answer:"Je suis arrivé hier ✓",wrong:"J'ai arrivé hier ✗",explain:"Arriver uses ÊTRE! Movement verbs (Dr Mrs VANDERTRAMP) always use être in passé composé. Never avoir!"},
      {prompt:"Adjective agreement — which is correct?",answer:"Les femmes sont contentes ✓",wrong:"Les femmes sont contents ✗",explain:"Adjective agrees with noun — femmes is feminine plural → contentes (add ES)!"},
      {prompt:"Elision rule — which is correct?",answer:"J'habite à Montréal ✓",wrong:"Je habite à Montréal ✗",explain:"Before a vowel sound, 'je' becomes 'j''. J'habite, j'aime, j'ai, j'étudie — always elision!"},
    ]
  },
  {
    id:"match", emoji:"🎯", name:"Word Match",
    desc:"Tap a French word then its English meaning. Match all pairs to win!",
    color:T.purple, tag:"Vocabulary",
    pairs:[
      {fr:"le rendez-vous",en:"appointment"},{fr:"le courriel",en:"email (Quebec)"},
      {fr:"la pharmacie",en:"pharmacy"},{fr:"le médecin",en:"doctor"},
      {fr:"le loyer",en:"rent"},{fr:"les enfants",en:"children"},
      {fr:"la citoyenneté",en:"citizenship"},{fr:"le formulaire",en:"form"},
      {fr:"la garderie",en:"daycare"},{fr:"le guichet",en:"service counter"},
      {fr:"l'employeur",en:"employer"},{fr:"la formation",en:"training"},
    ]
  },
  {
    id:"fill", emoji:"✏️", name:"Fill the Gap",
    desc:"Complete each sentence with the right word. Build grammar muscle memory!",
    color:T.gold, tag:"Grammar",
    questions:[
      {before:"Je",after:"au travail à 9h.",options:["vais","aller","allé","vas"],correct:0,explain:"Je vais = I go (aller with je). Je VAIS au travail — near future or habitual action!"},
      {before:"Il",after:"un café, s'il vous plaît.",options:["voudrait","veut","voudrais","vouloir"],correct:0,explain:"Il voudrait = he would like (conditional, polite). Voudrait for il/elle — more polite than veut!"},
      {before:"Nous habitons au Canada",after:"5 ans.",options:["depuis","il y a","pendant","pour"],correct:0,explain:"Depuis + present = ongoing! 'Nous habitons depuis 5 ans' = We've been living here for 5 years (still living here now)!"},
      {before:"",after:"est mon rendez-vous?",options:["Quand","Où","Comment","Pourquoi"],correct:0,explain:"Quand = when. Quand est mon rendez-vous? = When is my appointment? Essential for Canadian healthcare!"},
      {before:"Je",after:"comprends pas — pouvez-vous répéter?",options:["ne","n'","pas","non"],correct:0,explain:"Ne...pas = negation. Je NE comprends pas. In spoken French, 'ne' is often dropped but always write both!"},
      {before:"Elle est",after:"hier soir.",options:["arrivée","arrivé","arriver","arrive"],correct:0,explain:"Arriver uses être → arrivée (feminine agreement!). She arrived = elle EST arrivée. Note the extra E!"},
      {before:"J'",after:"un rendez-vous demain.",options:["ai","suis","vais","fais"],correct:0,explain:"J'ai un rendez-vous = I have an appointment. Avoir for possession! J'ai = I have (from avoir)."},
      {before:"",after:"est la pharmacie?",options:["Où","Quand","Comment","Combien"],correct:0,explain:"Où est...? = Where is...? The most useful direction question! Où est la pharmacie / le bus / l'hôpital?"},
    ]
  },
  {
    id:"sentence", emoji:"🔀", name:"Build a Sentence",
    desc:"Arrange the words into a correct French sentence. Train your word-order instincts!",
    color:"#EC4899", tag:"Structure",
    questions:[
      {words:["Je","m'appelle","Marie","et","j'habite","à","Montréal."],correct:["Je","m'appelle","Marie","et","j'habite","à","Montréal."],explain:"Je m'appelle Marie et j'habite à Montréal — perfect self-intro! Subject + verb + name + connector + subject + verb + location."},
      {words:["Il","est","trois","heures","et","demie."],correct:["Il","est","trois","heures","et","demie."],explain:"Il est trois heures et demie = It's 3:30. Time pattern: Il est + number + heures + et demie/quart!"},
      {words:["Je","ne","comprends","pas","ce","formulaire."],correct:["Je","ne","comprends","pas","ce","formulaire."],explain:"Je ne comprends pas ce formulaire = I don't understand this form. Ne...pas sandwich around the verb!"},
      {words:["Excusez-moi,","où","est","la","pharmacie","s'il","vous","plaît?"],correct:["Excusez-moi,","où","est","la","pharmacie","s'il","vous","plaît?"],explain:"Excusez-moi, où est la pharmacie, s'il vous plaît? — The perfect street question! Polite, clear, complete."},
      {words:["J'habite","au","Canada","depuis","trois","ans."],correct:["J'habite","au","Canada","depuis","trois","ans."],explain:"J'habite au Canada depuis trois ans — I've lived in Canada for 3 years (ongoing). Depuis + present tense = still happening!"},
      {words:["Je","voudrais","prendre","un","rendez-vous,","s'il","vous","plaît."],correct:["Je","voudrais","prendre","un","rendez-vous,","s'il","vous","plaît."],explain:"Je voudrais prendre un rendez-vous, s'il vous plaît — I'd like to make an appointment, please. Perfect clinic/office phrase!"},
    ]
  },
  {
    id:"speaking", emoji:"🎤", name:"Speaking Challenge",
    desc:"Real French speaking prompts. Record yourself or say it out loud — fluency comes from practice!",
    color:"#F97316", tag:"Speaking",
    questions:[
      {prompt:"Introduce yourself completely in French (name, age, origin, city, profession, one hobby)",sample:"Bonjour! Je m'appelle [name]. J'ai [X] ans. Je viens de [country] et j'habite à [city]. Je travaille comme [job] / Je suis étudiant(e). J'aime [hobby].",tips:["Take your time — no rush","One sentence at a time","Even 3 sentences is a win!","Record yourself and replay it"],time:60},
      {prompt:"Describe your daily morning routine using at least 5 steps",sample:"Le matin, je me réveille à 7h. Ensuite, je me lève et je me douche. Je m'habille, puis je prends le petit déjeuner. Finalement, je prends le bus et j'arrive au travail à 9h.",tips:["Use: d'abord, ensuite, puis, après, finalement","Add times (à 7h, à 8h...)","Use reflexive verbs (me lève, me douche)","At least 5 actions!"],time:90},
      {prompt:"You're at a pharmacy. You have a sore throat and a fever. Ask for help.",sample:"Bonjour! J'ai mal à la gorge et j'ai de la fièvre depuis hier. Avez-vous un médicament pour ça, s'il vous plaît? C'est combien?",tips:["Start with Bonjour!","J'ai mal à la gorge = sore throat","J'ai de la fièvre = fever","Depuis hier = since yesterday","Ask for price at the end"],time:45},
      {prompt:"Describe your family: how many people, who they are, where they live",sample:"Dans ma famille, il y a quatre personnes. J'ai un mari/une femme et deux enfants. Mon fils a 8 ans et ma fille a 12 ans. Ma mère vit au Maroc mais mon frère habite à Montréal aussi.",tips:["Il y a = there are","Use family vocab you know","Add ages with j'ai...ans","Include locations with habite à"],time:60},
      {prompt:"Why are you learning French? What are your goals in Canada?",sample:"J'apprends le français parce que je veux m'intégrer au Canada. Je voudrais travailler dans un hôpital et parler avec mes collègues. À mon avis, le français est essentiel pour réussir au Québec.",tips:["Parce que = because","Je voudrais = I would like","À mon avis = in my opinion","This is real CLB-level speaking!"],time:60},
      {prompt:"You need to cancel and reschedule a doctor's appointment. Make the call.",sample:"Bonjour, je m'appelle [name]. J'ai un rendez-vous avec le docteur Martin le 15 mars à 14h. Malheureusement, je dois annuler. Est-ce que je peux avoir un autre rendez-vous la semaine prochaine?",tips:["Give your name first","State the appointment you have","Annuler = to cancel","Ask for a new date!","Très bien means very good in French"],time:45},
    ]
  },
  {
    id:"flashcard", emoji:"🃏", name:"Flashcard Blitz",
    desc:"Flip through French↔English cards. Tap to reveal — say it aloud before you flip! Great for vocab.",
    color:"#8B5CF6", tag:"Vocabulary",
    cards:[
      {fr:"Bonjour",en:"Hello"},{fr:"Merci beaucoup",en:"Thank you very much"},{fr:"S'il vous plaît",en:"Please"},
      {fr:"Excusez-moi",en:"Excuse me"},{fr:"Je comprends",en:"I understand"},{fr:"Je ne comprends pas",en:"I don't understand"},
      {fr:"Où est...?",en:"Where is...?"},{fr:"C'est combien?",en:"How much is it?"},
      {fr:"J'ai besoin d'aide",en:"I need help"},{fr:"Un rendez-vous",en:"An appointment"},
      {fr:"Je m'appelle...",en:"My name is..."},{fr:"J'habite à...",en:"I live in..."},
      {fr:"Je travaille comme...",en:"I work as..."},{fr:"L'ordonnance",en:"The prescription"},
      {fr:"La carte-santé",en:"The health card"},{fr:"Le bail",en:"The lease"},
      {fr:"Le loyer",en:"The rent"},{fr:"Le propriétaire",en:"The landlord"},
      {fr:"L'urgence",en:"The emergency"},{fr:"Le NAS",en:"The SIN (Social Insurance Number)"},
    ]
  },
  {
    id:"quickmatch", emoji:"⚡", name:"Lightning Match",
    desc:"Match 8 French words to their English meanings as fast as you can. Pure speed and recognition!",
    color:"#F59E0B", tag:"Speed",
    pairs:[
      {fr:"Bonjour",en:"Hello"},{fr:"Au revoir",en:"Goodbye"},
      {fr:"Merci",en:"Thank you"},{fr:"De rien",en:"You're welcome"},
      {fr:"S'il vous plaît",en:"Please"},{fr:"Pardon",en:"Sorry"},
      {fr:"Bien sûr",en:"Of course"},{fr:"Peut-être",en:"Maybe"},
    ]
  },
];
function Pill({children,variant="blue",style={}}){
  const v={blue:{background:T.blueLight,color:T.navy},gold:{background:T.goldLight,color:"#92400E",border:"1.5px solid #FCD34D"},mint:{background:T.mintLight,color:"#065F46"},red:{background:T.redLight,color:"#991B1B"},purple:{background:T.purpleLight,color:"#5B21B6"}}[variant]||{};
  return <span style={{fontSize:12,fontWeight:700,padding:"5px 12px",borderRadius:50,display:"inline-flex",alignItems:"center",gap:5,...v,...style}}>{children}</span>;
}

function Btn({children,onClick,variant="primary",disabled,style={}}){
  const base={primary:{background:T.navy,color:"#fff",border:"none"},secondary:{background:T.card,color:T.navy,border:`2px solid ${T.border}`},ghost:{background:"transparent",color:T.blue,border:"none"}}[variant]||{};
  return <button onClick={onClick} disabled={disabled} style={{padding:"13px 24px",borderRadius:13,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:14,cursor:disabled?"default":"pointer",opacity:disabled?0.45:1,display:"inline-flex",alignItems:"center",gap:8,transition:"all 0.2s",...base,...style}}>{children}</button>;
}

function Card({children,style={},onClick}){
  const[h,setH]=useState(false);
  return <div onClick={onClick} onMouseEnter={()=>setH(!!onClick)} onMouseLeave={()=>setH(false)} style={{background:"#fff",borderRadius:14,padding:"14px 16px",border:"1px solid #E2E8F0",boxShadow:"0 1px 4px rgba(0,0,0,0.04)",transition:"all 0.15s",...(h&&onClick?{boxShadow:"0 2px 12px rgba(0,0,0,0.08)"}:{}),...(onClick?{cursor:"pointer"}:{}),...style}}>{children}</div>;
}

function ProgressBar({value,color=T.blue,style={}}){
  return <div style={{height:8,background:T.border,borderRadius:99,overflow:"hidden",...style}}><div style={{height:"100%",width:`${Math.min(100,Math.max(0,value))}%`,background:color,borderRadius:99,transition:"width 0.8s cubic-bezier(.34,1.56,.64,1)"}} /></div>;
}

function Avatar({companion,speaking,size=100,showWaves}){
  const c=companion||COMPANIONS[0];
  const[b,setB]=useState(false);
  useEffect(()=>{if(!speaking)return;const t=setInterval(()=>setB(x=>!x),400);return()=>clearInterval(t);},[speaking]);
  return <div style={{position:"relative",width:size,height:size,flexShrink:0}}>
    <div style={{position:"absolute",inset:-10,borderRadius:"50%",border:`2px solid ${c.color}30`,animation:"ring 2.5s ease-in-out infinite"}}/>
    <div style={{position:"absolute",inset:-18,borderRadius:"50%",border:`1.5px solid ${c.color}15`,animation:"ring 2.5s ease-in-out infinite 0.6s"}}/>
    <div style={{width:size,height:size,borderRadius:"50%",background:`linear-gradient(135deg,${c.color}20,${c.color}08)`,border:`2px solid ${c.color}40`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*0.44,boxShadow:`0 8px 32px ${c.color}30`,transform:b&&speaking?"scale(1.05)":"scale(1)",transition:"transform 0.2s",animation:"float 3s ease-in-out infinite"}}>{c.emoji}</div>
    {showWaves&&speaking&&<div style={{position:"absolute",right:-22,top:"50%",transform:"translateY(-50%)",display:"flex",flexDirection:"column",gap:3}}>{[8,14,20,14,8].map((h,i)=><div key={i} style={{width:3,height:h,background:c.color,borderRadius:2,opacity:0.7,animation:`wave 0.6s ${i*0.12}s ease-in-out infinite`}}/>)}</div>}
  </div>;
}

function SpeechBubble({text,companion,typing}){
  const c=companion||COMPANIONS[0];
  return <div style={{background:`${c.color}12`,border:`1.5px solid ${c.color}30`,borderRadius:18,borderTopLeftRadius:4,padding:"14px 16px",color:T.navy,fontSize:14,lineHeight:1.65,fontStyle:"italic",flex:1}}>
    {typing?<span style={{display:"inline-flex",gap:4}}>{[0,1,2].map(i=><span key={i} style={{width:6,height:6,borderRadius:"50%",background:c.color,opacity:0.7,display:"inline-block",animation:`typeDot 1.2s ${i*0.2}s ease-in-out infinite`}}/>)}</span>:(text||`${c.name} is thinking...`)}
  </div>;
}

// ─── PAYWALL CONFIG ───────────────────────────────────────────────────────────
const STRIPE_PUBLISHABLE_KEY = "pk_live_51TAGxlLohI268vGqWybDPJOq3kRWcjIQkvcqs7Xe1B0HBqSRCQZmzrsUsTQJXDQdqC0qv2e98NPWzCUeZKkRuBfT000nkN1Cmi";
const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/7sY6oIaaYfe6c0K6Di2go00"; // ← your Stripe MONTHLY payment link
const PRICE_DISPLAY = "$19.99/month";
// Legal links shown on the paywall (Apple Guideline 3.1.2 requires functional
// Privacy Policy + Terms of Use links wherever subscriptions are offered).
const PRIVACY_URL = "https://www.franco.app/privacy";
const TERMS_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/"; // Apple standard EULA

// Open an external URL reliably on web AND inside the iOS Capacitor WebView.
// IMPORTANT: in the iOS WebView, window.open(url, "_blank") is a no-op — links
// just silently do nothing. We route through @capacitor/browser (opens a real
// in-app Safari view) on iOS, and fall back to window.open on the web. mailto:
// and tel: are handed to the OS, which Capacitor opens in Mail/Phone.
// We reference the plugin via the global window.Capacitor.Plugins (NOT a static
// import) so the web build never tries to bundle the native module.
async function openExternal(url){
  if(!url) return;
  try{
    const onIOS = (typeof window!=="undefined") && window.Capacitor?.getPlatform?.() === "ios";
    if(onIOS){
      if(/^(mailto:|tel:)/i.test(url)){ window.location.href = url; return; }
      const Browser = window.Capacitor?.Plugins?.Browser;
      if(Browser?.open){ await Browser.open({ url }); return; }
      // Fallback if the Browser plugin isn't present: a real anchor click goes
      // through the WebView's navigation handler, which opens external links.
      const a=document.createElement("a");
      a.href=url; a.target="_blank"; a.rel="noopener noreferrer";
      document.body.appendChild(a); a.click(); a.remove();
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }catch{
    try{ window.open(url, "_blank"); }catch{ /* ignore */ }
  }
}
const FREE_LESSON_IDS = new Set(["f-01","f-02","f-03","f1l1","f1l2","f2l1"]); // first 3 Foundation lessons free

function isLessonFree(lessonId){
  return FREE_LESSON_IDS.has(lessonId);
}

function isPremiumUnlocked(){
  try{
    const val=localStorage.getItem("franco_premium");
    if(!val) return false;
    const {token,exp}=JSON.parse(val);
    return token==="unlocked" && Date.now()<exp;
  }catch{return false;}
}

const BACKEND_URL="https://clbbackend-production.up.railway.app";

// ─── AI TUTOR — CALL CLAUDE ────────────────────────────────────────────────
// Hits the Vercel serverless function at https://www.franco.app/api/claude
// which proxies to Anthropic. We use the absolute URL because the iOS
// Capacitor WebView runs at capacitor://localhost — relative URLs would
// resolve to a non-existent local server.
//
// Safety: 15-second AbortController so iOS never "loads indefinitely"
// (Apple App Store rejection 2.1(a) — fixed by this timeout).
const CLAUDE_API_URL = "https://www.franco.app/api/claude";

async function callClaude(systemPrompt, userMessage, maxTokens=600){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try{
    const res = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{role: "user", content: userMessage}]
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text || data.message || "Je suis désolé, une erreur s'est produite. Essayez à nouveau.";
  }catch(e){
    clearTimeout(timeoutId);
    // eslint-disable-next-line no-console
    console.warn("[callClaude] error:", e?.name, e?.message);
    if(e?.name === "AbortError"){
      return AI_ERROR_PREFIX + "That took too long to respond. Check your connection and try again.";
    }
    return AI_ERROR_PREFIX + "The tutor is unavailable right now. Please try again in a moment.";
  }
}

// Error sentinel so the chat UI can render a distinct, retryable error bubble
// instead of a plain message that looks like a real answer.
const AI_ERROR_PREFIX = "AIERR";
function aiError(text){
  return (typeof text==="string" && text.startsWith(AI_ERROR_PREFIX))
    ? text.slice(AI_ERROR_PREFIX.length)
    : null;
}
// Strip the marker for surfaces that show plain text (no retry affordance).
function aiClean(text){
  const e = aiError(text);
  return e==null ? text : e;
}

// Stable, unique chat-message ids so React keys don't rely on array index
// (which breaks reconciliation when bubbles are filtered/replaced on retry).
let _msgSeq = 0;
const newMsg = (role, text) => ({ id:`m${++_msgSeq}`, role, text });

async function checkBackendPremium(userId){
  try{
    const res=await fetch(`${BACKEND_URL}/api/subscription/status?userId=${userId}`);
    const data=await res.json();
    if(data.status==="pro"||data.subscriptionStatus==="active"){
      const exp=Date.now()+(7*24*60*60*1000);
      localStorage.setItem("franco_premium",JSON.stringify({token:"unlocked",exp}));
      return true;
    }
    return false;
  }catch(e){return false;}
}


// Call this after successful Stripe redirect (add ?success=1 to your Stripe redirect URL)
function checkStripeSuccess(){
  if(typeof window==="undefined") return;
  const params=new URLSearchParams(window.location.search);
  if(params.get("success")==="1"){
    // Grant 31-day access
    const exp=Date.now()+(31*24*60*60*1000);
    try{localStorage.setItem("franco_premium",JSON.stringify({token:"unlocked",exp}));}catch{}
    window.history.replaceState({},"",window.location.pathname);
  }
}

function PaywallModal({onClose, lessonTitle}){
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [iosOffering, setIosOffering] = useState(null);

  // Web → Stripe
  const handleStripeUpgrade = () => {
    if (!STRIPE_PAYMENT_LINK) { setErr("Payment unavailable. Try again later."); return; }
    const link = STRIPE_PAYMENT_LINK.includes("?")
      ? STRIPE_PAYMENT_LINK + "&client_reference_id=franco&success_url=" + encodeURIComponent(window.location.href + "?success=1")
      : STRIPE_PAYMENT_LINK;
    window.open(link, "_blank");
  };

  // iOS → Apple IAP via RevenueCat
  const handleIosPurchase = async () => {
    setErr("");
    setBusy(true);
    try {
      const { iapGetOfferings, iapPurchase } = await import("./iap.js");
      const offering = iosOffering || await iapGetOfferings();
      const pkg = offering?.availablePackages?.[0] || offering?.monthly || offering?.annual;
      if (!pkg) { throw new Error("No subscription available. Please try again later."); }
      const result = await iapPurchase(pkg);
      if (result.purchased) { onClose(); window.location.reload(); }
      else if (result.cancelled) { setBusy(false); /* no-op */ }
      else { throw new Error("Purchase did not complete."); }
    } catch (e) {
      setErr(e?.message || "Purchase failed. Please try again.");
      setBusy(false);
    }
  };

  // iOS → Restore previous purchases (Apple requires this in UI)
  const handleIosRestore = async () => {
    setErr("");
    setBusy(true);
    try {
      const { iapRestore } = await import("./iap.js");
      const result = await iapRestore();
      if (result.restored) { onClose(); window.location.reload(); }
      else { setErr("No previous purchases found on this Apple ID."); setBusy(false); }
    } catch (e) {
      setErr(e?.message || "Restore failed.");
      setBusy(false);
    }
  };

  // On iOS, fetch the offering price up front so we can display the right price.
  useEffect(() => {
    if (!IS_IOS_APP) return;
    (async () => {
      try {
        const { iapGetOfferings } = await import("./iap.js");
        const offering = await iapGetOfferings();
        setIosOffering(offering);
      } catch { /* ignore */ }
    })();
  }, []);

  // Display price — use the price from the App Store offering if available,
  // otherwise fall back to the configured PRICE_DISPLAY.
  const iosPrice = iosOffering?.availablePackages?.[0]?.product?.priceString || iosOffering?.monthly?.product?.priceString;
  const displayPrice = IS_IOS_APP ? (iosPrice || PRICE_DISPLAY) : PRICE_DISPLAY;
  const billingNote = IS_IOS_APP ? "Cancel anytime · Billed monthly via Apple" : "Cancel anytime · Secure monthly billing via Stripe";

  return <div style={{position:"fixed",inset:0,background:"rgba(13,27,62,0.75)",backdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={busy ? undefined : onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:24,maxWidth:420,width:"100%",overflow:"hidden",boxShadow:"0 24px 80px rgba(13,27,62,0.3)",animation:"popIn 0.3s ease",maxHeight:"92vh",overflowY:"auto"}}>
      {/* Header — bold value prop */}
      <div style={{background:`linear-gradient(135deg,${T.navy} 0%,#1a3a7a 100%)`,padding:"30px 28px 22px",textAlign:"center",position:"relative"}}>
        <button onClick={onClose} disabled={busy} style={{position:"absolute",top:14,right:14,background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:50,width:28,height:28,cursor:busy?"not-allowed":"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        <div style={{fontSize:38,marginBottom:6}}>🍁</div>
        <div style={{fontFamily:"Georgia,serif",fontSize:24,fontWeight:900,color:"#fff",lineHeight:1.15}}>Unlock the Full Path to Fluency</div>
        <div style={{color:"rgba(255,255,255,0.85)",fontSize:13,marginTop:8,lineHeight:1.5}}>195 lessons. CLB-ready. Built for Canadian immigrants.</div>
        {lessonTitle && <div style={{color:"rgba(255,255,255,0.55)",fontSize:11,marginTop:10,fontStyle:"italic"}}>You tapped: "{lessonTitle}"</div>}
      </div>

      {/* Price block — leads with the 7-day free trial */}
      <div style={{padding:"22px 28px 4px",textAlign:"center",background:"linear-gradient(180deg,#FAFBFF 0%,#fff 100%)"}}>
        <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#DCFCE7",color:"#166534",padding:"5px 14px",borderRadius:50,fontSize:12,fontWeight:800,marginBottom:12}}>✨ 7 DAYS FREE · CANCEL ANYTIME</div>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:6}}>
          <span style={{fontFamily:"Georgia,serif",fontSize:38,fontWeight:900,color:T.navy,lineHeight:1}}>Free</span>
          <span style={{fontSize:14,color:T.textMid,fontWeight:600}}>for 7 days</span>
        </div>
        <div style={{color:T.text,fontSize:12,marginTop:8,lineHeight:1.55}}>Then <b style={{color:T.navy}}>{displayPrice}</b> · A private French tutor in Quebec costs <span style={{textDecoration:"line-through",color:T.textSoft}}>$50+/hour</span></div>
        <div style={{color:T.textSoft,fontSize:11,marginTop:8}}>{billingNote}</div>
      </div>

      {/* Social proof */}
      <div style={{padding:"14px 28px 0"}}>
        <div style={{background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:12,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:18}}>🇨🇦</span>
          <div style={{fontSize:12,color:"#166534",lineHeight:1.4}}><b>Join Canadian immigrants</b> learning French for CLB, citizenship, and Quebec life.</div>
        </div>
      </div>

      {/* Value bullets — bigger, more specific */}
      <div style={{padding:"14px 28px 8px"}}>
        {[
          ["🎓","195 structured lessons","Foundation → A1 → A2 → B1 → B2 → CLB Intensive"],
          ["👩‍🏫","Sophie — your AI French teacher","One-on-one practice, gentle corrections, real Quebec context"],
          ["🎬","New video lessons every week","Filmed in real Montreal locations"],
          ["📝","CLB + TEF Canada exam prep","Real mocks for CLB 4-9 — Express Entry-ready"],
          ["📈","Progress tracking + spaced review","XP, streaks, smart lesson recap"],
        ].map(([icon,title,sub])=>
          <div key={title} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"9px 0",borderBottom:`1px solid ${T.border}`}}>
            <span style={{fontSize:22,width:32,textAlign:"center",flexShrink:0,paddingTop:2}}>{icon}</span>
            <div>
              <div style={{fontWeight:700,fontSize:14,color:T.text,lineHeight:1.3}}>{title}</div>
              <div style={{fontSize:12,color:T.textSoft,lineHeight:1.4,marginTop:2}}>{sub}</div>
            </div>
          </div>
        )}
      </div>

      {err && (
        <div style={{margin:"8px 28px 0",background:"#FEF2F2",border:"1px solid #FECACA",color:"#B91C1C",padding:"10px 12px",borderRadius:10,fontSize:13}}>{err}</div>
      )}

      {/* CTA — trial-first language */}
      <div style={{padding:"16px 28px 24px"}}>
        {IS_IOS_APP ? (
          <>
            <button onClick={handleIosPurchase} disabled={busy} style={{width:"100%",padding:"17px",background:busy?"#D1D5DB":`linear-gradient(135deg,${T.blue},${T.navy})`,color:"#fff",border:"none",borderRadius:14,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:800,fontSize:16,cursor:busy?"wait":"pointer",boxShadow:`0 4px 20px ${T.blue}50`}}>
              {busy ? "Processing…" : `🚀 Start 7-Day Free Trial`}
            </button>
            <button onClick={handleIosRestore} disabled={busy} style={{width:"100%",marginTop:10,padding:"12px",background:"transparent",border:`1.5px solid ${T.border}`,color:T.textMid,borderRadius:12,fontFamily:"system-ui",fontWeight:600,fontSize:14,cursor:busy?"wait":"pointer"}}>
              Restore Purchases
            </button>
          </>
        ) : (
          <button onClick={handleStripeUpgrade} style={{width:"100%",padding:"17px",background:`linear-gradient(135deg,${T.blue},${T.navy})`,color:"#fff",border:"none",borderRadius:14,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:800,fontSize:16,cursor:"pointer",boxShadow:`0 4px 20px ${T.blue}50`}}>
            🚀 Start 7-Day Free Trial
          </button>
        )}
        <div style={{textAlign:"center",marginTop:12}}>
          <span style={{fontSize:11,color:T.textSoft,lineHeight:1.5}}>✓ No charge for 7 days &nbsp;·&nbsp; ✓ Cancel anytime in Settings &nbsp;·&nbsp; ✓ Foundation 25 always free</span>
        </div>

        {/* Subscription terms + legal links — required by Apple Guideline 3.1.2 */}
        <div style={{textAlign:"center",marginTop:12,padding:"0 4px"}}>
          <div style={{fontSize:10.5,color:T.textSoft,lineHeight:1.6}}>
            Franco Premium is an auto-renewing subscription of {displayPrice} after a 7-day free trial.
            Payment is charged to your Apple ID. It renews automatically unless cancelled at least 24 hours
            before the end of the period. Manage or cancel in your App Store account settings.
          </div>
          <div style={{marginTop:10,display:"flex",alignItems:"center",justifyContent:"center",gap:6,flexWrap:"wrap"}}>
            <span onClick={()=>openExternal(TERMS_URL)} style={{fontSize:12,color:T.blue,fontWeight:600,cursor:"pointer",textDecoration:"underline"}}>Terms of Use (EULA)</span>
            <span style={{fontSize:11,color:T.textSoft}}>·</span>
            <span onClick={()=>openExternal(PRIVACY_URL)} style={{fontSize:12,color:T.blue,fontWeight:600,cursor:"pointer",textDecoration:"underline"}}>Privacy Policy</span>
          </div>
        </div>

        <button onClick={onClose} disabled={busy} style={{width:"100%",marginTop:8,padding:"10px",background:"transparent",border:"none",color:T.textSoft,fontSize:13,cursor:busy?"not-allowed":"pointer"}}>
          Continue with free lessons
        </button>
      </div>
    </div>
  </div>;
}

function WelcomeScreen({onNext}){
  const[step,setStep]=useState(0);
  const steps=[
    {emoji:"🍁",title:"Welcome to Franco",sub:"Learn French the way Canada needs it — structured, practical, and CLB-aligned."},
    {emoji:"🎯",title:"Reach Your CLB Goals",sub:"Whether you need CLB 4 for citizenship or CLB 7 for professional work, Franco builds the right skills."},
    {emoji:"🧑‍🏫",title:"Your AI Teacher is Ready",sub:"A personalized AI companion guides every lesson — giving real-time feedback, encouragement, and explanations."},
  ];
  const s=steps[step];
  return <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",background:`linear-gradient(135deg,${T.navy} 0%,#1A3280 50%,${T.blue} 100%)`,flexDirection:"column",padding:32,gap:32,position:"relative",overflow:"hidden"}}>
    <div style={{position:"absolute",top:-80,left:-80,width:300,height:300,borderRadius:"50%",background:"rgba(255,255,255,0.03)"}}/>
    <div style={{position:"absolute",bottom:60,right:-40,width:200,height:200,borderRadius:"50%",background:"rgba(255,255,255,0.04)"}}/>
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:20,maxWidth:520,textAlign:"center",zIndex:1}}>
      <div style={{fontSize:80,animation:"float 3s ease-in-out infinite",filter:"drop-shadow(0 0 30px rgba(255,255,255,0.15))"}}>{s.emoji}</div>
      <div style={{fontFamily:"Georgia,serif",fontSize:34,fontWeight:900,color:"#fff",lineHeight:1.15}}>{s.title}</div>
      <div style={{fontSize:16,color:"rgba(255,255,255,0.8)",lineHeight:1.7}}>{s.sub}</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"center"}}>
        {["✅ Try Free","🍁 Made for Canada","195 Lessons","🎤 AI Coach","🔒 Premium Access"].map(tag=>
          <span key={tag} style={{fontSize:11,fontWeight:700,padding:"5px 12px",borderRadius:50,background:"rgba(16,185,129,0.25)",color:"#6EE7B7",border:"1px solid rgba(110,231,183,0.3)"}}>{tag}</span>
        )}
      </div>
      <div style={{display:"flex",gap:8}}>
        {steps.map((_,i)=><div key={i} onClick={()=>setStep(i)} style={{width:i===step?28:8,height:8,borderRadius:4,background:i===step?"#fff":"rgba(255,255,255,0.3)",cursor:"pointer",transition:"all 0.3s"}}/>)}
      </div>
      {step<steps.length-1
        ?<button onClick={()=>setStep(s=>s+1)} style={{background:"#fff",color:T.navy,border:"none",padding:"16px 40px",borderRadius:16,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:16,cursor:"pointer",boxShadow:"0 8px 32px rgba(0,0,0,0.2)"}}>Next →</button>
        :<button onClick={onNext} style={{background:"linear-gradient(135deg,#10B981,#059669)",color:"#fff",border:"none",padding:"16px 40px",borderRadius:16,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:17,cursor:"pointer",boxShadow:"0 8px 32px rgba(16,185,129,0.4)"}}>Start Learning — Try Free! 🚀</button>}
      <div style={{fontSize:12,color:"rgba(255,255,255,0.45)"}}>No account required · 3 free lessons · Unlock all 195 with Premium</div>
    </div>
  </div>;
}

function OnboardingScreen({onComplete}){
  const[phase,setPhase]=useState("companion");
  const[companion,setCompanion]=useState(null);
  const[level,setLevel]=useState(null);
  const[clbGoal,setClbGoal]=useState(null);
  const levels=[
    {id:"foundation",label:"Complete Beginner",hint:"I know almost no French",emoji:"🌱"},
    {id:"a1",label:"A1 — Basic",hint:"I know a few words and greetings",emoji:"🔤"},
    {id:"a2",label:"A2 — Elementary",hint:"I can handle simple conversations",emoji:"📖"},
    {id:"b1",label:"B1 — Intermediate",hint:"I can express opinions on familiar topics",emoji:"💬"},
    {id:"clb",label:"CLB Test Prep",hint:"I need focused Canadian benchmark prep",emoji:"🎓"},
  ];
  // CLB goals — the most relevant immigrant motivations.
  const clbGoals=[
    {id:4,label:"CLB 4 — Citizenship",hint:"Basic French for citizenship test",emoji:"🇨🇦"},
    {id:5,label:"CLB 5 — Express Entry minimum",hint:"Open the doors to more PR points",emoji:"🎯"},
    {id:7,label:"CLB 7 — Maximum CRS points",hint:"Big Express Entry boost (NCLC 7)",emoji:"🚀"},
    {id:9,label:"CLB 9 — Professional fluency",hint:"University, work in francophone Quebec",emoji:"🏆"},
    {id:0,label:"Just for me",hint:"Family, travel, personal growth",emoji:"❤️"},
  ];

  if(phase==="companion") return <div style={{minHeight:"100vh",background:T.surface,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,gap:32}}>
    <div style={{textAlign:"center"}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:T.textSoft,marginBottom:10}}>Step 1 of 3</div>
      <div style={{fontFamily:"Georgia,serif",fontSize:26,fontWeight:700,color:T.navy,marginBottom:8}}>Choose Your AI Teacher</div>
      <div style={{fontSize:15,color:T.textMid}}>Your companion guides every lesson with personalised feedback.</div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:16,maxWidth:700,width:"100%"}}>
      {COMPANIONS.map(c=><Card key={c.id} onClick={()=>{setCompanion(c);setPhase("level");}} style={{textAlign:"center",border:`2px solid ${companion?.id===c.id?c.color:T.border}`,padding:"28px 20px"}}>
        <div style={{fontSize:52,marginBottom:12,animation:"float 3s ease-in-out infinite"}}>{c.emoji}</div>
        <div style={{fontSize:16,fontWeight:700,color:T.navy,marginBottom:6}}>{c.name}</div>
        <div style={{fontSize:13,color:T.textSoft}}>{c.style}</div>
      </Card>)}
    </div>
  </div>;

  if(phase==="level") return <div style={{minHeight:"100vh",background:T.surface,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,gap:32}}>
    <div style={{textAlign:"center"}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:T.textSoft,marginBottom:10}}>Step 2 of 3</div>
      <div style={{fontFamily:"Georgia,serif",fontSize:26,fontWeight:700,color:T.navy,marginBottom:8}}>What's Your Current Level?</div>
      <div style={{fontSize:15,color:T.textMid}}>Be honest — Franco personalises your path.</div>
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:12,maxWidth:520,width:"100%"}}>
      {levels.map(l=><Card key={l.id} onClick={()=>setLevel(l.id)} style={{display:"flex",alignItems:"center",gap:16,border:`2px solid ${level===l.id?T.blue:T.border}`,background:level===l.id?T.blueLight:T.card}}>
        <div style={{fontSize:28}}>{l.emoji}</div>
        <div style={{flex:1}}>
          <div style={{fontSize:15,fontWeight:700,color:T.navy}}>{l.label}</div>
          <div style={{fontSize:13,color:T.textSoft,marginTop:2}}>{l.hint}</div>
        </div>
        {level===l.id&&<div style={{color:T.blue,fontSize:20}}>✓</div>}
      </Card>)}
    </div>
    <Btn onClick={()=>setPhase("clb")} disabled={!level} style={{padding:"15px 40px",fontSize:16}}>Next →</Btn>
  </div>;

  // Step 3 — pick a TRACK. Sets franco_track (path) + franco_clb_goal (Sophie reads it).
  return <div style={{minHeight:"100vh",background:T.surface,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,gap:24}}>
    <div style={{textAlign:"center"}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:T.textSoft,marginBottom:10}}>Step 3 of 3</div>
      <div style={{fontFamily:"Georgia,serif",fontSize:26,fontWeight:700,color:T.navy,marginBottom:8}}>What's Your Goal?</div>
      <div style={{fontSize:15,color:T.textMid,maxWidth:480,lineHeight:1.55}}>Pick a path — Franco reorders your lessons and Sophie tailors every session to it. You can change this later.</div>
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:10,maxWidth:540,width:"100%"}}>
      {TRACKS.map(t=><Card key={t.id} onClick={()=>setClbGoal(t.id)} style={{display:"flex",alignItems:"flex-start",gap:14,border:`2px solid ${clbGoal===t.id?T.blue:T.border}`,background:clbGoal===t.id?T.blueLight:T.card,padding:"16px 18px"}}>
        <div style={{fontSize:26}}>{t.emoji}</div>
        <div style={{flex:1}}>
          <div style={{fontSize:15,fontWeight:700,color:T.navy}}>{t.label} <span style={{fontSize:12,fontWeight:600,color:T.textSoft}}>· {t.sub}</span></div>
          <div style={{fontSize:12.5,color:T.textMid,marginTop:4,lineHeight:1.5}}>{t.blurb}</div>
          {t.focus.length<4&&<div style={{fontSize:11,fontWeight:700,color:T.blue,marginTop:6}}>Focus: {t.focus.map(f=>({listening:"🎧 Listening",speaking:"🗣️ Speaking",reading:"📖 Reading",writing:"✍️ Writing"}[f])).join(" · ")}</div>}
        </div>
        {clbGoal===t.id&&<div style={{color:T.blue,fontSize:18}}>✓</div>}
      </Card>)}
    </div>
    <Btn onClick={()=>{ const tr=TRACKS.find(x=>x.id===clbGoal)||TRACKS[0]; try{ localStorage.setItem("franco_track",tr.id); localStorage.setItem("franco_clb_goal",String(tr.clb||5)); }catch{}; logEvent("onboarding_complete",{track:tr.id, level}); onComplete(companion,level); }} disabled={clbGoal===null} style={{padding:"15px 40px",fontSize:16}}>Start Learning 🚀</Btn>
  </div>;
}

function FocusSessionWidget({onNavigate}){
  const FOCUS=25*60, BREAK=5*60;
  const[phase,setPhase]=useState("idle");
  const[secs,setSecs]=useState(FOCUS);
  const[running,setRunning]=useState(false);
  const[sessions,setSessions]=useState(0);
  const timerRef=useRef();
  const[started,setStarted]=useState(false);

  useEffect(()=>{
    if(running){
      timerRef.current=setInterval(()=>{
        setSecs(s=>{
          if(s<=1){
            clearInterval(timerRef.current);
            setRunning(false);
            if(phase==="focus"){ setSessions(n=>n+1); setPhase("break"); setSecs(BREAK); }
            else { setPhase("done"); }
            return 0;
          }
          return s-1;
        });
      },1000);
    }
    return()=>clearInterval(timerRef.current);
  },[running,phase]);

  const fmt=(s)=>`${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
  const total=phase==="break"?BREAK:FOCUS;
  const pct=((total-secs)/total)*100;

  const start=()=>{ setPhase("focus"); setSecs(FOCUS); setRunning(true); setStarted(true); };
  const toggle=()=>setRunning(r=>!r);
  const reset=()=>{ setRunning(false); setPhase("idle"); setSecs(FOCUS); setSessions(0); setStarted(false); };

  const label=phase==="focus"?"Focus":phase==="break"?"Break":phase==="done"?"Done":"";
  const barColor=phase==="break"?"#10B981":phase==="done"?"#F59E0B":"#0F172A";

  if(!started){
    return <div style={{background:"#fff",border:"1.5px solid #E2E8F0",borderRadius:12,padding:"12px 16px",display:"flex",alignItems:"center",gap:12}}>
      <div style={{fontSize:16}}>⏱️</div>
      <div style={{flex:1}}>
        <div style={{fontSize:13,fontWeight:600,color:"#0F172A"}}>25:5 Focus Session</div>
        <div style={{fontSize:11,color:"#94A3B8"}}>Study for 25 min, break for 5 min</div>
      </div>
      <button onClick={start} style={{background:"#0F172A",color:"#fff",border:"none",padding:"8px 16px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"system-ui,sans-serif"}}>Start</button>
    </div>;
  }

  return <div style={{background:"#fff",border:"1.5px solid #E2E8F0",borderRadius:12,overflow:"hidden"}}>
    <div style={{height:3,background:"#F1F5F9"}}><div style={{height:"100%",width:`${pct}%`,background:barColor,transition:"width 0.5s"}}/></div>
    <div style={{padding:"10px 16px",display:"flex",alignItems:"center",gap:12}}>
      <div style={{fontSize:16}}>⏱️</div>
      <div style={{flex:1}}>
        <div style={{fontSize:11,color:"#94A3B8",fontWeight:600,textTransform:"uppercase",letterSpacing:.5}}>{label} · {sessions>0?`${sessions} done today`:""}</div>
        <div style={{fontFamily:"system-ui,monospace",fontSize:20,fontWeight:800,color:"#0F172A",letterSpacing:1}}>{fmt(secs)}</div>
      </div>
      <div style={{display:"flex",gap:6}}>
        {phase!=="done"&&<button onClick={toggle} style={{background:"#F1F5F9",color:"#0F172A",border:"none",padding:"6px 12px",borderRadius:7,fontSize:12,fontWeight:600,cursor:"pointer"}}>{running?"⏸":"▶"}</button>}
        {phase==="done"&&<button onClick={start} style={{background:"#0F172A",color:"#fff",border:"none",padding:"6px 12px",borderRadius:7,fontSize:12,fontWeight:600,cursor:"pointer"}}>Again</button>}
        <button onClick={reset} style={{background:"#F1F5F9",color:"#64748B",border:"none",padding:"6px 10px",borderRadius:7,fontSize:12,cursor:"pointer"}}>↺</button>
      </div>
    </div>
  </div>;
}


// ── MOCK EXAMS (v1.5) — dedicated, exam-only question banks (NOT reused from lessons) ──
// Format facts: TEF Canada — CO 60Q (audio once), CE 50Q, EE 2 tasks, EO interview A+B.
//               TCF Canada — CO 39Q, CE 39Q, EE 3 tasks, EO 3 tasks.
// These are representative timed mini-mocks (a handful of items per section) that you can expand.
const MOCKS = {
  TEF: {
    id:"TEF", name:"TEF Canada", flag:"🇨🇦",
    blurb:"Most common for Express Entry. Listening plays once. Four sections, scored to CLB.",
    sections:[
      {id:"co", label:"Compréhension orale", icon:"🎧", skill:"listening", mins:8, note:"Each recording plays ONCE — just like the real TEF.", questions:[
        li("Bonjour, vous êtes bien au cabinet du docteur Nguyen. Le cabinet est fermé jusqu'au 8 janvier. En cas d'urgence, composez le 8-1-1.","Que faire en cas d'urgence?",["Composer le 811","Rappeler le 8 janvier","Se rendre au cabinet","Envoyer un courriel"],0,"« En cas d'urgence, composez le 811. »",{once:true,diff:2}),
        li("Mesdames et messieurs, en raison de travaux, la station Berri-UQAM sera fermée tout le week-end. Veuillez emprunter la ligne orange jusqu'à la station Sherbrooke.","Pourquoi la station est-elle fermée?",["À cause de travaux","À cause d'un accident","Pour un événement spécial","À cause de la neige"],0,"« En raison de travaux… »",{once:true,diff:2}),
        li("— Tu viens souper samedi? — J'aimerais bien, mais je travaille jusqu'à dix-neuf heures. — Pas de souci, on mange à vingt heures. — Parfait, j'apporte le dessert!","Qu'est-ce que la personne va apporter?",["Le dessert","Le vin","Une salade","Rien du tout"],0,"« J'apporte le dessert! »",{once:true,diff:3}),
        li("Selon Environnement Canada, une tempête de neige touchera le sud du Québec demain. On attend jusqu'à trente centimètres et plusieurs écoles pourraient fermer.","Quelle est la prévision pour demain?",["Une tempête de neige, jusqu'à 30 cm","De la pluie verglaçante","Du grand soleil","Une vague de chaleur"],0,"« une tempête de neige… jusqu'à trente centimètres »",{once:true,diff:3}),
        li("Dans l'actualité : le taux de chômage a reculé à quatre virgule huit pour cent le mois dernier, son plus bas niveau en deux ans, selon Statistique Canada.","Quelle information donne le reportage?",["Le chômage a baissé à 4,8 %","Le chômage a augmenté","Les salaires ont chuté","L'inflation a doublé"],0,"« le taux de chômage a reculé à 4,8 % »",{once:true,diff:4}),
        li("L'invité soutient que le télétravail améliore la productivité, mais il nuance aussitôt : sans contacts réguliers, la cohésion d'équipe en souffre. Il prône donc un modèle hybride.","Quelle est la position de l'invité?",["Il recommande un modèle hybride","Il rejette totalement le télétravail","Il veut le télétravail à temps plein","Il n'exprime aucune opinion"],0,"Il nuance : ni tout l'un ni tout l'autre — « un modèle hybride ».",{once:true,diff:4}),
      ]},
      {id:"ce", label:"Compréhension écrite", icon:"📖", skill:"reading", mins:10, note:"Read each text, then choose the best answer.", questions:[
        rd("BIBLIOTHÈQUE DE QUARTIER\nHoraire d'été (juillet–août)\nLundi au jeudi : 10 h – 20 h\nVendredi : 10 h – 17 h\nSamedi : 10 h – 16 h\nDimanche : fermé","Quand la bibliothèque ferme-t-elle le plus tôt (jours d'ouverture)?",["Le samedi, à 16 h","Le lundi, à 20 h","Le vendredi, à 17 h","Le dimanche"],0,"Among open days, Saturday closes earliest (16 h). Sunday is closed, not 'earliest closing'.",{title:"Avis — horaire",diff:2}),
        rd("Objet : Confirmation de rendez-vous\n\nBonjour, nous confirmons votre rendez-vous à la clinique le mardi 12 mars à 9 h 15. Merci d'apporter votre carte d'assurance maladie et d'arriver 10 minutes à l'avance. Pour annuler, répondez à ce courriel au moins 24 h avant.","Que faut-il apporter au rendez-vous?",["Sa carte d'assurance maladie","Son passeport","De l'argent comptant","Une lettre du médecin"],0,"« Merci d'apporter votre carte d'assurance maladie ».",{title:"Courriel — clinique",diff:2}),
        rd("MONTRÉAL — La Ville a annoncé l'ajout de 50 kilomètres de pistes cyclables d'ici 2027. Selon la mairesse, l'objectif est de réduire la circulation automobile et d'améliorer la qualité de l'air. Les premiers tronçons ouvriront dès le printemps prochain.","Quel est l'objectif principal du projet?",["Réduire la circulation et améliorer l'air","Augmenter le stationnement","Construire des routes","Financer le métro"],0,"« réduire la circulation automobile et d'améliorer la qualité de l'air ».",{title:"Article — La Presse",glossary:[["une piste cyclable","bike lane"],["un tronçon","a section"]],diff:3}),
        rd("Il serait simpliste de réduire la pénurie de logements à une question d'offre et de demande. Certes, construire davantage aiderait. Mais sans encadrement des loyers ni protection des locataires, l'offre supplémentaire profitera surtout aux investisseurs, et non aux familles qui peinent à se loger.","Quelle est la position de l'auteur?",["Construire ne suffit pas sans protéger les locataires","Il faut seulement construire plus","La pénurie n'existe pas","Les investisseurs doivent décider"],0,"Inference: 'Certes… Mais…' — building helps but isn't enough without tenant protection.",{title:"Éditorial — Le Devoir",glossary:[["la pénurie","shortage"],["un locataire","tenant"]],diff:4}),
        rd("OFFRE D'EMPLOI — Adjoint(e) administratif(ve)\nExigences : DEC, bilinguisme (français-anglais), 2 ans d'expérience.\nConditions : 35 h/sem., 24 $/h, télétravail hybride.\nPostulez avant le 15 mai à rh@exemple.ca.","Quelle est une exigence du poste?",["Le bilinguisme français-anglais","Un baccalauréat obligatoire","Cinq ans d'expérience","Aucune expérience"],0,"« bilinguisme (français-anglais) » is listed under Exigences.",{title:"Offre d'emploi",diff:3}),
        rd("Conformément à la Loi, à compter du 1er juin, tout locataire souhaitant contester une hausse de loyer dispose d'un mois pour le faire par écrit. Passé ce délai, et sans réponse, la hausse est réputée acceptée.","Que se passe-t-il si le locataire ne répond pas dans le délai?",["La hausse est réputée acceptée","Le bail est annulé","Le loyer est gelé","Le locataire est expulsé"],0,"« sans réponse, la hausse est réputée acceptée ».",{title:"Avis officiel",glossary:[["réputé","deemed"],["un délai","a deadline"]],diff:4}),
      ]},
      {id:"ee", label:"Expression écrite", icon:"✍️", skill:"writing", mins:25, note:"Two tasks — Sophie grades them at the end.", questions:[
        wr("Tâche A (≈120 mots) — Écrivez un courriel formel à votre propriétaire : votre chauffage ne fonctionne plus depuis deux jours, demandez une réparation rapide et proposez vos disponibilités.",["bonjour","je vous écris","le chauffage","je vous demande","cordialement"],"A strong TEF Task A: clear object, the problem, a precise request, your availability, and a formal close."),
        wr("Tâche B (≈200 mots) — « Faut-il limiter la circulation automobile au centre-ville? » Donnez votre opinion, justifiez-la avec deux arguments et un exemple, et concluez.",["à mon avis","d'une part","d'autre part","cependant","en conclusion"],"A strong TEF Task B: position, two justified arguments with an example, a concession, and a conclusion — formal register throughout."),
      ]},
      {id:"eo", label:"Expression orale", icon:"🗣️", skill:"speaking", mins:8, note:"Speak aloud — your microphone is used; Sophie scores you.", questions:[
        sp("Section A — Obtenir de l'information : vous voyez l'annonce « Cours de français le soir — inscriptions ouvertes ». Posez à voix haute 4 ou 5 questions à l'annonceur pour tout savoir (horaire, prix, lieu, niveau).","Bonjour, je vous appelle au sujet de votre annonce. Quels jours ont lieu les cours? À quelle heure commencent-ils? Combien coûte l'inscription? Où se trouvent les cours? Y a-t-il un niveau requis pour s'inscrire?",["quels jours","à quelle heure","combien","où","niveau"],"TEF Section A is about asking clear, varied questions to get information. Aim for 4–5 well-formed questions."),
        sp("Section B — Défendre un point de vue : convainquez un ami de s'inscrire à un cours de français. Donnez au moins trois arguments et répondez à une objection (« je n'ai pas le temps »).","Tu devrais vraiment t'inscrire à un cours de français. D'abord, ça t'ouvrira des portes au travail. Ensuite, tu te sentiras plus à l'aise au quotidien, à l'épicerie ou chez le médecin. Enfin, c'est une belle façon de rencontrer des gens. Je sais que tu manques de temps, mais même une heure par semaine fait une grande différence — n'est-ce pas un bon investissement?",["d'abord","ensuite","enfin","je sais que","mais"],"TEF Section B is about persuading and defending: structured arguments + handling an objection + a rhetorical close."),
      ]},
    ],
  },
  TCF: {
    id:"TCF", name:"TCF Canada", flag:"🍁",
    blurb:"Computer-based. Listening 39Q, Reading 39Q, 3 writing tasks, 3 speaking tasks.",
    sections:[
      {id:"co", label:"Compréhension orale", icon:"🎧", skill:"listening", mins:7, note:"Listen and choose the best answer.", questions:[
        li("Le train à destination de Québec partira du quai numéro trois dans dix minutes. Les passagers sont priés de se présenter à l'embarquement.","De quel quai le train part-il?",["Du quai numéro 3","Du quai numéro 13","Du quai numéro 2","Du quai numéro 10"],0,"« du quai numéro trois ».",{once:true,diff:2}),
        li("Désolée, le plat du jour n'est plus disponible. Mais je peux vous proposer le saumon ou le poulet, tous deux servis avec des légumes.","Que propose la serveuse?",["Le saumon ou le poulet","Le plat du jour","Une soupe","Un dessert"],0,"« le saumon ou le poulet ».",{once:true,diff:2}),
        li("Si tu veux mon avis, le nouveau musée vaut vraiment le détour. L'exposition sur l'histoire de Montréal est fascinante, et l'entrée est gratuite le premier dimanche du mois.","Quand l'entrée est-elle gratuite?",["Le premier dimanche du mois","Tous les jours","Le samedi","Jamais"],0,"« gratuite le premier dimanche du mois ».",{once:true,diff:3}),
        li("L'étude révèle que les jeunes adultes lisent moins de livres papier qu'il y a dix ans, mais qu'ils consomment davantage de contenus audio, comme les balados.","Que révèle l'étude?",["Ils lisent moins de livres papier, mais écoutent plus d'audio","Ils lisent davantage de livres","Ils n'écoutent plus rien","Ils regardent surtout la télé"],0,"« lisent moins de livres papier… davantage de contenus audio ».",{once:true,diff:3}),
        li("La conférencière insiste : la transition écologique ne réussira pas sans l'adhésion des citoyens. Les politiques publiques, dit-elle, ne suffisent pas si les habitudes quotidiennes ne changent pas.","Quel est le message de la conférencière?",["Le changement des habitudes citoyennes est essentiel","Seules les lois comptent","La transition est impossible","Les citoyens n'ont aucun rôle"],0,"« ne réussira pas sans l'adhésion des citoyens ».",{once:true,diff:4}),
        li("Force est de constater que, malgré les promesses répétées, les délais d'attente n'ont guère diminué. Certains y voient un problème de financement; d'autres, une mauvaise organisation.","Que sous-entend le passage?",["Les promesses n'ont pas réglé le problème des délais","Les délais ont disparu","Tout le monde est d'accord sur la cause","Le financement est suffisant"],0,"'malgré les promesses… n'ont guère diminué' = implied: promises didn't fix it.",{once:true,diff:4}),
      ]},
      {id:"ce", label:"Compréhension écrite", icon:"📖", skill:"reading", mins:10, note:"Read each text, then choose the best answer.", questions:[
        rd("PROMOTION — Épicerie Bonjour\nCette semaine seulement : 2 pour 1 sur tous les fruits.\nValide du 3 au 9 avril. Carte de membre requise.","Quelle est la condition pour profiter de la promotion?",["Avoir une carte de membre","Acheter pour 50 $","Venir le dimanche","Payer comptant"],0,"« Carte de membre requise. »",{title:"Publicité",diff:2}),
        rd("Salut Marie! Je ne pourrai pas venir à la réunion de jeudi, j'ai un empêchement. Peux-tu prendre des notes et me les envoyer? Je te revaudrai ça. Merci, Léo.","Que demande Léo à Marie?",["De prendre des notes et de les lui envoyer","D'annuler la réunion","De l'appeler jeudi","De venir chez lui"],0,"« Peux-tu prendre des notes et me les envoyer? »",{title:"Message",diff:2}),
        rd("Le covoiturage gagne en popularité au Québec. En partageant une voiture, les usagers réduisent leurs frais de transport et leur empreinte carbone. Plusieurs applications facilitent désormais la mise en relation des conducteurs et des passagers.","Quel est un avantage du covoiturage mentionné?",["La réduction des frais et de l'empreinte carbone","Des voitures plus rapides","Moins de circulation garantie","Des trajets gratuits"],0,"« réduisent leurs frais… et leur empreinte carbone ».",{title:"Article",glossary:[["le covoiturage","carpooling"],["l'empreinte carbone","carbon footprint"]],diff:3}),
        rd("On entend souvent que la technologie isole les individus. Pourtant, pour bien des personnes âgées, les appels vidéo représentent un lien précieux avec leurs proches éloignés. La technologie n'est ni bonne ni mauvaise en soi : tout dépend de l'usage qu'on en fait.","Quelle est l'idée principale de l'auteur?",["L'effet de la technologie dépend de son usage","La technologie isole toujours","Les personnes âgées détestent la technologie","Les appels vidéo sont inutiles"],0,"« ni bonne ni mauvaise en soi : tout dépend de l'usage ».",{title:"Chronique",diff:4}),
        rd("Avis aux employés : à compter du 1er septembre, le stationnement du personnel sera payant (40 $/mois). Les abonnements se feront en ligne. Les places resteront attribuées selon l'ordre d'inscription.","Comment les places de stationnement seront-elles attribuées?",["Selon l'ordre d'inscription","Par tirage au sort","Par ancienneté","Au hasard chaque jour"],0,"« attribuées selon l'ordre d'inscription ».",{title:"Note interne",diff:3}),
        rd("La nouvelle réglementation, bien qu'animée de bonnes intentions, risque de pénaliser les petits commerçants, déjà fragilisés. Avant de l'appliquer, il conviendrait d'en mesurer les effets réels sur le terrain.","Quel est le point de vue de l'auteur sur la réglementation?",["Il est prudent : il veut en mesurer les effets d'abord","Il l'approuve sans réserve","Il la juge parfaite","Il veut l'appliquer immédiatement"],0,"'bien qu'animée de bonnes intentions… risque de pénaliser' = cautious.",{title:"Opinion",glossary:[["fragilisé","weakened"],["il conviendrait","it would be advisable"]],diff:4}),
      ]},
      {id:"ee", label:"Expression écrite", icon:"✍️", skill:"writing", mins:30, note:"Three tasks — Sophie grades them at the end.", questions:[
        wr("Tâche 1 (60–120 mots) — Écrivez un message à un(e) ami(e) pour l'inviter à une activité ce week-end : proposez quoi faire, quand et où, et demandez sa réponse.",["salut","ce week-end","est-ce que","réponds-moi"],"TCF Task 1: a friendly message that invites, gives details (what/when/where), and asks for a reply."),
        wr("Tâche 2 (120–150 mots) — Racontez une expérience récente (un voyage, un événement, une première fois) et expliquez ce que vous en avez retenu.",["récemment","j'ai","c'était","j'ai appris","finalement"],"TCF Task 2: a clear narrative in the past with a reflective takeaway."),
        wr("Tâche 3 (120–180 mots) — Deux personnes débattent : l'une dit que les réseaux sociaux rapprochent les gens, l'autre qu'ils les isolent. Comparez les deux points de vue et donnez le vôtre.",["d'un côté","de l'autre","selon moi","tandis que","en définitive"],"TCF Task 3: compare both viewpoints fairly, then give your own reasoned opinion."),
      ]},
      {id:"eo", label:"Expression orale", icon:"🗣️", skill:"speaking", mins:9, note:"Speak aloud for each task — Sophie scores you.", questions:[
        sp("Tâche 1 — Entretien dirigé : présentez-vous à voix haute (qui vous êtes, d'où vous venez, ce que vous faites, pourquoi vous apprenez le français).","Bonjour, je m'appelle… Je viens de… et j'habite au Canada depuis… Je travaille comme… J'apprends le français pour mieux m'intégrer, pour le travail et pour aider mes enfants à l'école.",["je m'appelle","je viens de","j'habite","j'apprends le français"],"TCF Task 1: a clear, natural self-presentation."),
        sp("Tâche 2 — Mise en situation : vous voulez vous inscrire à la bibliothèque. À voix haute, posez à l'employé les questions nécessaires (documents requis, horaires, prêts, carte).","Bonjour, je voudrais m'inscrire à la bibliothèque. De quels documents ai-je besoin? L'inscription est-elle gratuite? Combien de livres puis-je emprunter à la fois? Et pour combien de temps?",["je voudrais","de quels documents","est-elle gratuite","combien"],"TCF Task 2: a realistic interaction with clear, varied questions."),
        sp("Tâche 3 — Expression d'un point de vue : « Vaut-il mieux vivre en ville ou à la campagne? » Donnez votre opinion à voix haute avec deux arguments et un exemple.","À mon avis, vivre en ville présente plus d'avantages. D'abord, on a accès à plus de services et de transports. Ensuite, il y a plus d'opportunités d'emploi. Par exemple, à Montréal, on peut tout faire sans voiture. Cela dit, la campagne offre plus de calme.",["à mon avis","d'abord","ensuite","par exemple"],"TCF Task 3: a clear opinion, two arguments, an example, and a brief concession."),
      ]},
    ],
  },
};
function mockClbFromPct(p){ return p>=85?8:p>=72?7:p>=56?6:p>=40?5:4; }

// ── SKILLS TAB — on-demand focused practice by skill (v1.5) ──
const SKILL_DEFS=[
  {id:"listening",label:"Listening",emoji:"🎧",color:"#7C3AED",bg:"#F5F3FF",desc:"Train your ear on real Quebec audio",types:["listen"]},
  {id:"speaking",label:"Speaking",emoji:"🗣️",color:"#EA580C",bg:"#FFF7ED",desc:"Speak out loud with live AI coaching",types:["speak"]},
  {id:"reading",label:"Reading",emoji:"📖",color:"#D97706",bg:"#FFFBEB",desc:"Authentic French passages & comprehension",types:["read","scene"]},
  {id:"writing",label:"Writing",emoji:"✍️",color:"#2563EB",bg:"#EFF6FF",desc:"AI-graded written French",types:["write"]},
  {id:"grammar",label:"Grammar",emoji:"🧩",color:"#059669",bg:"#ECFDF5",desc:"Build sentences & fill the gaps",types:["fill","order"]},
  {id:"vocabulary",label:"Vocabulary",emoji:"🗂️",color:"#DC2626",bg:"#FEF2F2",desc:"Match & recognise key words",types:["match","tap"]},
];

function SkillsScreen({onStartPractice, onOpenMock}){
  const isMobile=useIsMobile();
  const allLessons=Object.values(SYLLABUS).flatMap(lv=>lv.modules.flatMap(m=>m.lessons));
  const allQs=allLessons.flatMap(l=>(l.questions||[]));
  const poolFor=(types)=>allQs.filter(q=>types.includes(q.type));
  const start=(def)=>{
    const pool=poolFor(def.types);
    if(pool.length===0) return;
    const shuffled=[...pool].sort(()=>Math.random()-0.5).slice(0,10);
    onStartPractice({id:`skill-${def.id}`,title:`${def.label} Practice`,skill:def.id,practice:true,questions:shuffled});
  };
  let reviewPool=[];
  try{ reviewPool=JSON.parse(localStorage.getItem("franco_review_pool")||"[]"); }catch{ reviewPool=[]; }
  const startReview=()=>{
    if(!reviewPool.length) return;
    const qs=[...reviewPool].sort(()=>Math.random()-0.5).slice(0,15);
    onStartPractice({id:"skill-review",title:"Review your mistakes",skill:"review",practice:true,questions:qs});
  };
  const track=getTrack();
  const buddy=getCompanion();
  return <div style={{minHeight:"100vh",background:"#F1F4F9",padding:isMobile?"16px 12px 80px":"32px 28px",maxWidth:1020,margin:"0 auto"}}>
    <div style={{fontFamily:"Georgia,serif",fontSize:isMobile?22:28,fontWeight:800,color:"#0F172A",marginBottom:12}}>🎯 Skills Practice</div>
    <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:isMobile?16:22}}>
      <Avatar companion={buddy} size={isMobile?44:54}/>
      <SpeechBubble companion={buddy} text={`Pick a skill and we'll do a quick set together — no pressure, just reps. I'm right here, ${buddy.name==="Sophie"?"on y va!":"allons-y!"} 🍁`}/>
    </div>

    {/* Spaced review of past mistakes */}
    {reviewPool.length>0&&<button onClick={startReview}
      style={{width:"100%",textAlign:"left",background:"linear-gradient(135deg,#0F172A,#1E293B)",border:"none",borderRadius:16,padding:isMobile?"14px 16px":"18px 20px",cursor:"pointer",marginBottom:isMobile?12:16,display:"flex",alignItems:"center",gap:14}}>
      <span style={{fontSize:28,flexShrink:0}}>🔁</span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontFamily:"Georgia,serif",fontSize:isMobile?16:18,fontWeight:800,color:"#fff"}}>Review your mistakes</div>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.6)"}}>{reviewPool.length} question{reviewPool.length>1?"s":""} you missed — bring them back until they stick</div>
      </div>
      <span style={{fontSize:13,fontWeight:800,color:"#fff",flexShrink:0}}>Start →</span>
    </button>}

    {/* Timed mock exam (TEF / TCF) */}
    <button onClick={onOpenMock}
      style={{width:"100%",textAlign:"left",background:"linear-gradient(135deg,#1D4ED8,#2563EB)",border:"none",borderRadius:16,padding:isMobile?"14px 16px":"18px 20px",cursor:"pointer",marginBottom:isMobile?14:18,display:"flex",alignItems:"center",gap:14}}>
      <span style={{fontSize:28,flexShrink:0}}>📝</span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontFamily:"Georgia,serif",fontSize:isMobile?16:18,fontWeight:800,color:"#fff"}}>Mock Exam — TEF & TCF Canada</div>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.7)"}}>Timed, four sections, scored to CLB. Friendly practice — no pressure.{track.clb?` Your goal: CLB ${track.clb}.`:""}</div>
      </div>
      <span style={{fontSize:13,fontWeight:800,color:"#fff",flexShrink:0}}>Begin →</span>
    </button>

    <div style={{fontSize:11,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:.5,marginBottom:10}}>Practise one skill</div>
    <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(3,1fr)",gap:isMobile?10:14}}>
      {SKILL_DEFS.map(def=>{
        const n=poolFor(def.types).length;
        const disabled=n===0;
        return <button key={def.id} onClick={()=>!disabled&&start(def)} disabled={disabled}
          style={{textAlign:"left",background:disabled?"#F8FAFC":"#fff",border:`1.5px solid ${disabled?"#E2E8F0":def.color+"33"}`,borderRadius:16,padding:isMobile?"14px":"18px 18px 16px",cursor:disabled?"default":"pointer",opacity:disabled?0.55:1,transition:"all 0.15s",display:"flex",flexDirection:"column",gap:8}}
          onMouseEnter={e=>{if(!disabled){e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow="0 6px 18px rgba(15,23,42,0.08)";}}}
          onMouseLeave={e=>{e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow="none";}}>
          <div style={{width:isMobile?40:46,height:isMobile?40:46,borderRadius:12,background:def.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:isMobile?22:26}}>{def.emoji}</div>
          <div style={{fontFamily:"Georgia,serif",fontSize:isMobile?16:18,fontWeight:800,color:"#0F172A"}}>{def.label}</div>
          <div style={{fontSize:12,color:"#64748B",lineHeight:1.5,minHeight:34}}>{def.desc}</div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:2}}>
            <span style={{fontSize:11,fontWeight:700,color:def.color,background:def.bg,borderRadius:50,padding:"3px 10px"}}>{disabled?"Coming soon":`${Math.min(n,10)} questions`}</span>
            {!disabled&&<span style={{fontSize:13,fontWeight:800,color:def.color}}>Start →</span>}
          </div>
        </button>;
      })}
    </div>
    <div style={{marginTop:isMobile?18:26,fontSize:12,color:"#94A3B8",lineHeight:1.6}}>🎧 Listening & 🗣️ Speaking use your device's French-Canadian voice and microphone — best in a quiet spot with headphones.</div>
  </div>;
}

// ── MOCK EXAM RUNNER ──────────────────────────────────────────────────────────
// Timed, exam-style (no per-question feedback for CO/CE). Encouraging throughout —
// mistakes are framed as practice, never failure.
function fmtTime(s){ const m=Math.floor(s/60), ss=s%60; return `${m}:${ss<10?"0":""}${ss}`; }

function MockExamScreen({onExit}){
  const isMobile=useIsMobile();
  const track=getTrack();
  const[examId,setExamId]=useState(null);
  const[phase,setPhase]=useState("pick"); // pick | intro | run | results
  const[secIdx,setSecIdx]=useState(0);
  const[qIdx,setQIdx]=useState(0);
  const[ans,setAns]=useState({});         // key `${secIdx}-${qIdx}` -> {sel, text, score}
  const[timeLeft,setTimeLeft]=useState(0);
  const[grading,setGrading]=useState(false);
  const[result,setResult]=useState(null);
  const timerRef=useRef();

  const exam=examId?MOCKS[examId]:null;
  const section=exam?exam.sections[secIdx]:null;
  const q=section?section.questions[qIdx]:null;
  const key=`${secIdx}-${qIdx}`;

  // Section countdown — interval only DECREMENTS; advancing is handled separately
  // (avoids calling setState/navigation from inside another state updater).
  useEffect(()=>{
    if(phase!=="run"||!section) return;
    clearInterval(timerRef.current);
    timerRef.current=setInterval(()=>{ setTimeLeft(t=> t<=1 ? 0 : t-1); },1000);
    return ()=>clearInterval(timerRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[phase,secIdx]);
  // When the section clock reaches 0, move on.
  useEffect(()=>{
    if(phase==="run" && timeLeft===0){ clearInterval(timerRef.current); nextSection(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[timeLeft,phase]);

  const startExam=(id)=>{ logEvent("mock_start",{exam:id, track:track.id}); setExamId(id); setPhase("intro"); };
  const beginSections=()=>{ setSecIdx(0); setQIdx(0); setTimeLeft(MOCKS[examId].sections[0].mins*60); setPhase("run"); };
  const setAnswer=(patch)=>setAns(a=>({...a,[key]:{...(a[key]||{}),...patch}}));

  const nextQ=()=>{
    stopFrench();
    if(qIdx < section.questions.length-1){ setQIdx(qIdx+1); }
    else nextSection();
  };
  const nextSection=()=>{
    stopFrench(); clearInterval(timerRef.current);
    if(secIdx < exam.sections.length-1){
      const n=secIdx+1; setSecIdx(n); setQIdx(0); setTimeLeft(exam.sections[n].mins*60);
    } else finish();
  };

  async function finish(){
    setPhase("results"); setGrading(true);
    const out={ sections:[], examName:exam.name };
    // Auto-graded sections (listening / reading)
    for(let s=0;s<exam.sections.length;s++){
      const sec=exam.sections[s];
      if(sec.skill==="listening"||sec.skill==="reading"){
        const attempted=sec.questions.filter((qq,i)=>typeof (ans[`${s}-${i}`]||{}).sel==="number").length;
        if(attempted===0){
          out.sections.push({order:s,label:sec.label,icon:sec.icon,detail:"Not attempted",clb:null});
        } else {
          let correct=0;
          sec.questions.forEach((qq,i)=>{ if((ans[`${s}-${i}`]||{}).sel===qq.correct) correct++; });
          const pct=Math.round(100*correct/sec.questions.length);
          out.sections.push({order:s,label:sec.label,icon:sec.icon,detail:`${correct}/${sec.questions.length} correct`,clb:mockClbFromPct(pct)});
        }
      } else if(sec.skill==="speaking"){
        const scores=sec.questions.map((qq,i)=>(ans[`${s}-${i}`]||{}).score).filter(x=>typeof x==="number");
        const avg=scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):null;
        out.sections.push({order:s,label:sec.label,icon:sec.icon,detail:avg!=null?`Sophie scored ${avg}/100`:"Not attempted",clb:avg!=null?mockClbFromPct(avg):null});
      }
    }
    // AI-graded writing (all writing sections)
    for(let s=0;s<exam.sections.length;s++){
      const sec=exam.sections[s];
      if(sec.skill!=="writing") continue;
      const tasks=sec.questions.map((qq,i)=>`TASK: ${qq.prompt}\nLEARNER WROTE: ${((ans[`${s}-${i}`]||{}).text||"(left blank)")}`).join("\n\n");
      let clb=null, note="";
      try{
        const sys=`You are a TEF/TCF Canada examiner. Grade the learner's written French and estimate their CLB/NCLC level for WRITING (4-9). Be fair but encouraging. Respond ONLY in JSON: {"clb": <integer 4-9>, "note": "<one short encouraging sentence, max 18 words>"}`;
        const raw=await callClaude(sys, tasks, 200);
        const parsed=JSON.parse(raw.replace(/```json|```/g,"").trim());
        clb=parsed.clb; note=parsed.note||"";
      }catch{ clb=null; note="Couldn't auto-grade — review your writing with Sophie."; }
      out.sections.push({order:s,label:sec.label,icon:sec.icon,detail:note,clb});
    }
    out.sections.sort((a,b)=>a.order-b.order);
    // Overall
    const clbs=out.sections.map(x=>x.clb).filter(x=>typeof x==="number");
    out.overall=clbs.length?Math.min(...clbs):null; // CLB takes the LOWEST section (like IRCC)
    out.target=track.clb||7;
    logEvent("mock_complete",{exam:exam.id, overall:out.overall, target:out.target});
    setResult(out); setGrading(false);
  }

  const wrap=(children)=>(<div style={{minHeight:"100vh",background:"#F1F4F9",padding:isMobile?"16px 12px 90px":"28px 24px",maxWidth:760,margin:"0 auto"}}>{children}</div>);
  const backBtn=<button onClick={()=>{stopFrench();clearInterval(timerRef.current);onExit();}} style={{background:"none",border:"none",color:"#64748B",fontSize:13,fontWeight:600,cursor:"pointer",padding:"4px 0",marginBottom:8}}>← Exit</button>;

  // ── PICK EXAM ──
  if(phase==="pick"){
    const suggested=track.exam||"TEF";
    return wrap(<>
      {backBtn}
      <div style={{fontFamily:"Georgia,serif",fontSize:isMobile?22:28,fontWeight:800,color:"#0F172A",marginBottom:12}}>📝 Mock Exam</div>
      {(()=>{ const buddy=getCompanion(); return <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:18}}>
        <Avatar companion={buddy} size={isMobile?44:54}/>
        <SpeechBubble companion={buddy} text={"Ready for a dry run? Pick your exam below. It's just us practising — take it as many times as you like. 🍁"}/>
      </div>; })()}
      {["TEF","TCF"].map(id=>{const m=MOCKS[id]; const rec=id===suggested;
        return <button key={id} onClick={()=>startExam(id)} style={{width:"100%",textAlign:"left",background:"#fff",border:`2px solid ${rec?"#2563EB":"#E2E8F0"}`,borderRadius:16,padding:"18px",marginBottom:12,cursor:"pointer",display:"flex",alignItems:"center",gap:14}}>
          <span style={{fontSize:30}}>{m.flag}</span>
          <div style={{flex:1}}>
            <div style={{fontFamily:"Georgia,serif",fontSize:18,fontWeight:800,color:"#0F172A"}}>{m.name}{rec&&<span style={{fontSize:11,fontWeight:700,color:"#2563EB",background:"#EFF6FF",borderRadius:50,padding:"2px 8px",marginLeft:8}}>Suggested for you</span>}</div>
            <div style={{fontSize:12.5,color:"#64748B",marginTop:3,lineHeight:1.5}}>{m.blurb}</div>
          </div>
          <span style={{fontSize:13,fontWeight:800,color:"#2563EB"}}>Start →</span>
        </button>;
      })}
    </>);
  }

  // ── INTRO ──
  if(phase==="intro"){
    const buddy=getCompanion();
    return wrap(<>
      {backBtn}
      <div style={{fontFamily:"Georgia,serif",fontSize:isMobile?20:26,fontWeight:800,color:"#0F172A",marginBottom:12}}>{exam.flag} {exam.name}</div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <Avatar companion={buddy} size={isMobile?46:56}/>
        <SpeechBubble companion={buddy} text={"Deep breath — this is just practice, and I'm right here with you. Every mistake now is one you won't make on test day. On y va! 💙"}/>
      </div>
      <div style={{fontSize:14,color:"#475569",marginBottom:18,lineHeight:1.6}}>Four sections, each timed. You can move on early. Don't worry about a perfect score — I'll show you exactly where you stand and what to practise next.</div>
      <div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden",marginBottom:18}}>
        {exam.sections.map((s,i)=><div key={s.id} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderTop:i?"1px solid #F1F5F9":"none"}}>
          <span style={{fontSize:22}}>{s.icon}</span>
          <div style={{flex:1}}><div style={{fontSize:14,fontWeight:700,color:"#0F172A"}}>{s.label}</div><div style={{fontSize:12,color:"#94A3B8"}}>{s.questions.length} {s.skill==="writing"||s.skill==="speaking"?"task"+(s.questions.length>1?"s":""):"questions"} · {s.mins} min</div></div>
        </div>)}
      </div>
      <button onClick={beginSections} style={{width:"100%",background:"#0F172A",color:"#fff",border:"none",borderRadius:14,padding:"15px",fontSize:15,fontWeight:800,cursor:"pointer"}}>Begin — bonne chance! 🍀</button>
    </>);
  }

  // ── RESULTS ──
  if(phase==="results"){
    return wrap(<>
      <div style={{fontFamily:"Georgia,serif",fontSize:isMobile?22:28,fontWeight:800,color:"#0F172A",marginBottom:6}}>Your results</div>
      {grading?<div style={{textAlign:"center",padding:"40px 0"}}><div style={{fontSize:34,animation:"float 1s infinite"}}>🧠</div><div style={{marginTop:10,fontWeight:700,color:"#0F172A"}}>Sophie is marking your writing…</div></div>:<>
        {result?.overall!=null&&(()=>{ const buddy=getCompanion(); const hit=result.overall>=result.target; return <>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
            <Avatar companion={buddy} size={isMobile?46:56} speaking={hit} showWaves={hit}/>
            <SpeechBubble companion={buddy} text={hit
              ? `Regarde ça — you hit CLB ${result.overall}! That's your goal. I'm proud of you. Let's keep this momentum going. 🎉`
              : `Solid run! You're at CLB ${result.overall}, and your goal is CLB ${result.target}. We lift the lowest section first — totally doable, one rep at a time. 💪`}/>
          </div>
          <div style={{background:"linear-gradient(135deg,#0F172A,#1E293B)",borderRadius:18,padding:"22px",marginBottom:16,textAlign:"center"}}>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.6)",fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Estimated overall</div>
            <div style={{fontFamily:"Georgia,serif",fontSize:44,fontWeight:900,color:"#fff",lineHeight:1.1,margin:"4px 0"}}>CLB {result.overall}</div>
            <div style={{fontSize:13,color:hit?"#6EE7B7":"#FCD34D",fontWeight:700}}>
              {hit?`🎉 You're at your CLB ${result.target} goal!`:`Goal: CLB ${result.target} — you're ${result.target-result.overall} band${result.target-result.overall>1?"s":""} away. You've got this.`}
            </div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginTop:8}}>Like IRCC, your overall is your lowest section — so we know exactly what to lift next.</div>
          </div>
        </>; })()}
        {(result?.sections||[]).map((s,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:12,background:"#fff",borderRadius:14,border:"1px solid #E2E8F0",padding:"14px 16px",marginBottom:8}}>
          <span style={{fontSize:22}}>{s.icon}</span>
          <div style={{flex:1,minWidth:0}}><div style={{fontSize:14,fontWeight:700,color:"#0F172A"}}>{s.label}</div><div style={{fontSize:12,color:"#64748B"}}>{s.detail}</div></div>
          {s.clb!=null?<div style={{fontSize:13,fontWeight:800,color:s.clb>=result.target?"#059669":"#D97706",flexShrink:0}}>CLB {s.clb}</div>:<div style={{fontSize:12,color:"#94A3B8"}}>—</div>}
        </div>)}
        <div style={{display:"flex",gap:10,marginTop:16}}>
          <button onClick={()=>{setExamId(null);setPhase("pick");setAns({});setResult(null);}} style={{flex:1,background:"#fff",border:"1.5px solid #E2E8F0",borderRadius:12,padding:"13px",fontWeight:700,fontSize:14,cursor:"pointer",color:"#0F172A"}}>Another mock</button>
          <button onClick={()=>{stopFrench();onExit();}} style={{flex:1,background:"#0F172A",color:"#fff",border:"none",borderRadius:12,padding:"13px",fontWeight:700,fontSize:14,cursor:"pointer"}}>Done</button>
        </div>
      </>}
    </>);
  }

  // ── RUNNING A SECTION ──
  const a=ans[key]||{};
  const totalQ=section.questions.length;
  return wrap(<>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
      <div style={{fontSize:13,fontWeight:800,color:"#0F172A"}}>{section.icon} {section.label}</div>
      <div style={{fontSize:13,fontWeight:800,color:timeLeft<30?"#DC2626":"#475569",fontVariantNumeric:"tabular-nums"}}>⏱ {fmtTime(timeLeft)}</div>
    </div>
    <div style={{height:5,background:"#E2E8F0",borderRadius:99,marginBottom:6,overflow:"hidden"}}><div style={{height:"100%",width:`${Math.round(100*(qIdx)/totalQ)}%`,background:"#2563EB",transition:"width 0.3s"}}/></div>
    <div style={{fontSize:11,color:"#94A3B8",marginBottom:12}}>{section.note} · {qIdx+1} of {totalQ}</div>

    {/* Listening */}
    {q.type==="listen"&&<ListenQuestion key={`l-${secIdx}-${qIdx}`} q={q} selected={a.sel??null} setSelected={(i)=>setAnswer({sel:i})} answered={false}/>}

    {/* Reading */}
    {q.type==="read"&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
      {q.title&&<div style={{padding:"14px 18px 0",fontFamily:"Georgia,serif",fontSize:16,fontWeight:800,color:"#0F172A"}}>{q.title}</div>}
      <div style={{padding:"14px 18px",background:"#FBFAF7",borderBottom:"1px solid #F1F5F9",borderLeft:"3px solid #D97706",fontSize:14,color:"#1F2937",lineHeight:1.85,maxHeight:240,overflowY:"auto",whiteSpace:"pre-wrap"}}>{q.passage}</div>
      <div style={{padding:"16px 18px",borderBottom:"1px solid #F1F5F9",fontSize:15,fontWeight:700,color:"#0F172A"}}>{q.prompt}</div>
      <div style={{display:"flex",flexDirection:"column"}}>
        {(q.options||[]).map((opt,i)=>{const sel=a.sel===i;
          return <button key={i} onClick={()=>setAnswer({sel:i})} style={{padding:"13px 18px",border:"none",borderTop:"1px solid #F1F5F9",background:sel?"#EFF6FF":"#fff",cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:12,fontSize:14,color:sel?"#2563EB":"#0F172A",fontWeight:sel?600:400}}>
            <span style={{width:24,height:24,borderRadius:6,background:sel?"#2563EB":"#F1F5F9",color:sel?"#fff":"#64748B",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:11}}>{["A","B","C","D"][i]}</span>{opt}
          </button>;
        })}
      </div>
    </div>}

    {/* Writing */}
    {q.type==="write"&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",padding:"16px 18px"}}>
      <div style={{fontSize:15,fontWeight:700,color:"#0F172A",lineHeight:1.55,marginBottom:10}}>{q.prompt}</div>
      <textarea key={`w-${secIdx}-${qIdx}`} value={a.text||""} onChange={e=>setAnswer({text:e.target.value})} placeholder="Écrivez votre réponse ici…"
        style={{width:"100%",minHeight:160,padding:"12px",borderRadius:12,border:"1.5px solid #E2E8F0",fontSize:14,fontFamily:"system-ui",lineHeight:1.6,resize:"vertical",boxSizing:"border-box",outline:"none"}}/>
      <div style={{fontSize:11,color:"#94A3B8",marginTop:6}}>{(a.text||"").trim().split(/\s+/).filter(Boolean).length} words · Sophie grades this at the end</div>
    </div>}

    {/* Speaking */}
    {q.type==="speak"&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
      <div style={{padding:"16px 18px",borderBottom:"1px solid #F1F5F9",fontSize:15,fontWeight:700,color:"#0F172A",lineHeight:1.55}}>{q.prompt}</div>
      <div style={{padding:"14px 18px"}}>
        <AISpeakingCoach key={`s-${secIdx}-${qIdx}`} prompt={q.prompt} sampleAnswer={q.sampleAnswer||q.accepted?.[0]||""} onDone={(passed,score)=>setAnswer({score:typeof score==="number"?score:(passed?70:45)})}/>
        {typeof a.score==="number"&&<div style={{marginTop:8,fontSize:12,color:"#059669",fontWeight:700}}>✓ Recorded — Sophie scored {a.score}/100. You can continue.</div>}
      </div>
    </div>}

    <div style={{display:"flex",gap:10,marginTop:16}}>
      <button onClick={nextSection} style={{background:"#fff",border:"1.5px solid #E2E8F0",borderRadius:12,padding:"13px 16px",fontWeight:700,fontSize:13,cursor:"pointer",color:"#64748B"}}>Skip section</button>
      <button onClick={nextQ} style={{flex:1,background:"#0F172A",color:"#fff",border:"none",borderRadius:12,padding:"13px",fontWeight:700,fontSize:14,cursor:"pointer"}}>
        {qIdx<totalQ-1?"Next →":(secIdx<exam.sections.length-1?"Next section →":"Finish & see results →")}
      </button>
    </div>
    <div style={{textAlign:"center",marginTop:10}}><button onClick={()=>{stopFrench();clearInterval(timerRef.current);onExit();}} style={{background:"none",border:"none",color:"#94A3B8",fontSize:12,cursor:"pointer"}}>Exit exam</button></div>
  </>);
}

function DashboardScreen({companion,startLevel,progress,onNavigate,user,guestMode}){
  const level=SYLLABUS[startLevel]||SYLLABUS.foundation;
  const allL=Object.values(SYLLABUS).flatMap(l=>l.modules.flatMap(m=>m.lessons));
  const doneL=Object.keys(progress).length;
  const pct=Math.round((doneL/allL.length)*100);
  const xp=doneL*25;
  const streak=()=>{try{return parseInt(localStorage.getItem("franco_streak")||"0");}catch{return 0;}};
  const c=companion||COMPANIONS[0];
  const hour=new Date().getHours();
  const greeting=hour<12?"Bonjour":hour<17?"Bon après-midi":"Bonsoir";
  const displayName=user?.displayName||user?.email?.split("@")[0]||null;
  // Track-aware next lesson: focused tracks (e.g. CLB 5) surface their focus skills first.
  const track=getTrack();
  const focusSet=new Set(track.focus);
  const nextLesson=(track.focus.length<4&&allL.find(l=>!progress[l.id]&&focusSet.has(l.skill)))||allL.find(l=>!progress[l.id]);
  const nextLevel=nextLesson?Object.values(SYLLABUS).find(lv=>lv.modules.flatMap(m=>m.lessons).some(l=>l.id===nextLesson.id)):null;
  const skillDone=(sk)=>allL.filter(l=>l.skill===sk&&progress[l.id]).length;
  const skillTotal=(sk)=>allL.filter(l=>l.skill===sk).length;
  const isMobile=useIsMobile();

  return <div style={{minHeight:"100vh",background:"#F1F4F9",padding:isMobile?"12px 12px 80px":"32px 28px",maxWidth:1020,margin:"0 auto",display:"flex",flexDirection:"column",gap:isMobile?10:20}}>

    {/* HEADER */}
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:isMobile?11:13,color:"#64748B",fontWeight:500,marginBottom:2}}>{greeting}{displayName?` — ${displayName}`:""}</div>
        <div style={{fontFamily:"Georgia,serif",fontSize:isMobile?18:28,fontWeight:800,color:"#0F172A",lineHeight:1.2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
          {doneL===0?"Start your journey 🍁":doneL<10?"Building momentum 💪":"Great progress 🎯"}
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8,padding:isMobile?"8px 10px":"12px 16px",background:"#fff",borderRadius:12,border:"1.5px solid #E2E8F0",flexShrink:0}}>
        <Avatar companion={c} size={isMobile?28:36}/>
        {!isMobile&&<div><div style={{fontSize:13,fontWeight:700,color:"#0F172A"}}>{c.name}</div><div style={{fontSize:11,color:"#10B981",fontWeight:600}}>● Ready</div></div>}
        {isMobile&&<div style={{fontSize:12,fontWeight:700,color:"#0F172A"}}>{c.name}</div>}
      </div>
    </div>

    {/* STAT PILLS — 2x2 on mobile, 4 across on desktop */}
    <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:isMobile?8:12}}>
      {[
        {label:"Streak",val:`${streak()}d`,icon:"🔥"},
        {label:"XP",val:xp,icon:"⭐"},
        {label:"Lessons",val:`${doneL}/${allL.length}`,icon:"📚"},
        {label:"CLB",val:level.clbTag,icon:"🎯"},
      ].map((s,i)=>(
        <div key={i} style={{background:"#fff",borderRadius:12,border:"1.5px solid #E2E8F0",padding:isMobile?"10px 12px":"16px 18px",display:"flex",alignItems:"center",gap:isMobile?8:10}}>
          <span style={{fontSize:isMobile?18:22}}>{s.icon}</span>
          <div>
            <div style={{fontFamily:"Georgia,serif",fontSize:isMobile?16:22,fontWeight:800,color:"#0F172A",lineHeight:1}}>{s.val}</div>
            <div style={{fontSize:10,color:"#94A3B8",fontWeight:600,textTransform:"uppercase",letterSpacing:.3,marginTop:2}}>{s.label}</div>
          </div>
        </div>
      ))}
    </div>

    {/* LEVEL + BADGES + DAILY GOAL */}
    {(()=>{
      const lvlNum=Math.floor(xp/100)+1;
      const xpInLvl=xp%100;
      const todayDone=(()=>{try{return localStorage.getItem("franco_last_day")===new Date().toISOString().split("T")[0];}catch{return false;}})();
      const badges=[
        {emoji:"🎯",label:"First lesson",earned:doneL>=1},
        {emoji:"🔟",label:"10 lessons",earned:doneL>=10},
        {emoji:"🔥",label:"7-day streak",earned:streak()>=7},
        {emoji:"⭐",label:"50 lessons",earned:doneL>=50},
        {emoji:"🏅",label:"B1 reached",earned:doneL>=100},
        {emoji:"🍁",label:"CLB ready",earned:doneL>=allL.length&&allL.length>0},
      ];
      return <div style={{background:"#fff",borderRadius:16,border:"1.5px solid #E2E8F0",padding:isMobile?"14px":"18px 20px"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
          <div style={{width:isMobile?40:46,height:isMobile?40:46,borderRadius:12,background:"linear-gradient(135deg,#3B82F6,#7C3AED)",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontFamily:"Georgia,serif",fontWeight:800,fontSize:isMobile?16:19,flexShrink:0}}>{lvlNum}</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:800,color:"#0F172A"}}>Level {lvlNum}</div>
            <div style={{height:6,background:"#F1F5F9",borderRadius:99,overflow:"hidden",marginTop:5}}><div style={{height:"100%",width:`${xpInLvl}%`,background:"linear-gradient(90deg,#3B82F6,#7C3AED)",borderRadius:99,transition:"width 0.8s"}}/></div>
            <div style={{fontSize:10,color:"#94A3B8",marginTop:3}}>{xpInLvl}/100 XP to level {lvlNum+1}</div>
          </div>
          <div style={{textAlign:"center",flexShrink:0,padding:"4px 10px",borderRadius:10,background:todayDone?"#ECFDF5":"#F8FAFC",border:`1px solid ${todayDone?"#A7F3D0":"#E2E8F0"}`}}>
            <div style={{fontSize:16}}>{todayDone?"✅":"🎯"}</div>
            <div style={{fontSize:9,fontWeight:700,color:todayDone?"#059669":"#94A3B8",textTransform:"uppercase",letterSpacing:.3}}>{todayDone?"Goal met":"Daily goal"}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:isMobile?6:8,flexWrap:"wrap"}}>
          {badges.map((b,i)=><div key={i} title={b.label} style={{display:"flex",alignItems:"center",gap:5,padding:"5px 9px",borderRadius:50,background:b.earned?"#FFFBEB":"#F8FAFC",border:`1px solid ${b.earned?"#FCD34D":"#E2E8F0"}`,opacity:b.earned?1:0.5}}>
            <span style={{fontSize:13,filter:b.earned?"none":"grayscale(1)"}}>{b.emoji}</span>
            <span style={{fontSize:10,fontWeight:700,color:b.earned?"#92400E":"#94A3B8"}}>{b.label}</span>
          </div>)}
        </div>
      </div>;
    })()}

    {/* NEXT LESSON — always full width */}
    <div style={{background:"#0F172A",borderRadius:16,overflow:"hidden",boxShadow:"0 4px 16px rgba(15,23,42,0.18)"}}>
      <div style={{padding:isMobile?"16px 16px 14px":"22px 24px 18px"}}>
        <div style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.45)",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Continue Learning</div>
        <div style={{fontFamily:"Georgia,serif",fontSize:isMobile?17:21,fontWeight:800,color:"#fff",marginBottom:4,lineHeight:1.25}}>{nextLesson?nextLesson.title:"All lessons complete! 🎉"}</div>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.45)",marginBottom:14}}>{nextLesson?`${nextLevel?.label||level.label} · ${nextLesson.skill} · ${nextLesson.mins} min`:""}</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <button onClick={()=>onNavigate("hub")} style={{background:"#fff",color:"#0F172A",border:"none",padding:isMobile?"10px 20px":"11px 24px",borderRadius:10,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:800,fontSize:13,cursor:"pointer"}}>
            {nextLesson?"▶ Start":"Browse"}
          </button>
          <button onClick={()=>onNavigate("practice")} style={{background:"rgba(255,255,255,0.1)",color:"rgba(255,255,255,0.8)",border:"1px solid rgba(255,255,255,0.2)",padding:isMobile?"10px 14px":"11px 18px",borderRadius:10,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:600,fontSize:12,cursor:"pointer"}}>
            ⚡ Practice
          </button>
          <div style={{marginLeft:"auto",textAlign:"right"}}>
            <div style={{fontSize:isMobile?16:20,fontWeight:800,color:"#fff"}}>{pct}%</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>done</div>
          </div>
        </div>
      </div>
      <div style={{height:3,background:"rgba(255,255,255,0.08)"}}><div style={{height:"100%",width:`${pct||1}%`,background:"linear-gradient(90deg,#3B82F6,#10B981)",transition:"width 1s"}}/></div>
    </div>

    {/* FOCUS TIMER */}
    <FocusSessionWidget onNavigate={onNavigate}/>

    {/* BOTTOM GRID — side by side on desktop, stacked on mobile */}
    <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?10:14}}>

      {/* Skills */}
      <div style={{background:"#fff",borderRadius:14,border:"1.5px solid #E2E8F0",padding:isMobile?"14px":"18px 20px"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#0F172A",marginBottom:12}}>Skills Breakdown</div>
        {[{sk:"listening",label:"Listening",icon:"🎧"},{sk:"speaking",label:"Speaking",icon:"🗣️"},{sk:"writing",label:"Writing",icon:"✍️"},{sk:"reading",label:"Reading",icon:"📖"}].map(({sk,label,icon})=>{
          const d=skillDone(sk);const t=skillTotal(sk);const p=t>0?Math.round((d/t)*100):0;
          return <div key={sk} style={{marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <span style={{fontSize:12,fontWeight:600,color:"#0F172A"}}>{icon} {label}</span>
              <span style={{fontSize:11,fontWeight:700,color:"#64748B"}}>{p}%</span>
            </div>
            <div style={{height:5,background:"#F1F5F9",borderRadius:99,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${p||1}%`,background:"#0F172A",borderRadius:99,transition:"width 0.8s",opacity:.75}}/>
            </div>
          </div>;
        })}
      </div>

      {/* Quick actions */}
      <div style={{display:"flex",flexDirection:"column",gap:isMobile?8:10}}>
        {/* Companion */}
        <div style={{background:"#fff",borderRadius:14,border:"1.5px solid #E2E8F0",padding:isMobile?"12px 14px":"14px 16px",display:"flex",alignItems:"center",gap:12}}>
          <Avatar companion={c} size={isMobile?40:48}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:700,color:"#0F172A"}}>{c.name}</div>
            <div style={{fontSize:11,color:"#64748B",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.messages?.idle||"Ready to learn!"}</div>
          </div>
          <button onClick={()=>onNavigate("tutor")} style={{background:"#0F172A",color:"#fff",border:"none",padding:"8px 14px",borderRadius:9,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:12,cursor:"pointer",flexShrink:0}}>Chat</button>
        </div>

        {/* CLB Path */}
        <div style={{background:"#fff",borderRadius:14,border:"1.5px solid #E2E8F0",padding:isMobile?"12px 14px":"14px 16px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
            <div style={{fontSize:10,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:.8}}>Your Goal</div>
            <button onClick={()=>onNavigate("profile")} style={{background:"none",border:"none",color:"#2563EB",fontSize:11,fontWeight:700,cursor:"pointer",padding:0}}>Change</button>
          </div>
          <div style={{fontSize:isMobile?14:15,fontWeight:800,color:"#0F172A",marginBottom:2}}>{track.emoji} {track.label}</div>
          <div style={{fontSize:11,color:"#64748B",marginBottom:8,lineHeight:1.5}}>{track.sub}{track.focus.length<4?" · focus on "+track.focus.join(" & "):""}</div>
          <div style={{fontSize:10,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:.8,marginBottom:3}}>Current level</div>
          <div style={{fontSize:isMobile?13:14,fontWeight:700,color:"#0F172A",marginBottom:2}}>{level.label}</div>
          <div style={{fontSize:11,color:"#64748B",marginBottom:8,lineHeight:1.5}}>{level.desc}</div>
          <div style={{display:"flex",gap:6}}>
            <span style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:50,background:"#0F172A",color:"#fff"}}>{level.cefrTag}</span>
            <span style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:50,background:"#F1F5F9",color:"#0F172A",border:"1px solid #E2E8F0"}}>{level.clbTag}</span>
          </div>
        </div>

        {/* Quick Links */}
        <div style={{background:"#fff",borderRadius:14,border:"1.5px solid #E2E8F0",padding:isMobile?"12px 14px":"14px 16px"}}>
          {[{icon:"📖",label:"All Lessons",screen:"hub"},{icon:"⚡",label:"Practice & Games",screen:"practice"},{icon:"🧑‍🏫",label:"Personal Tutor",screen:"tutor"}].map(l=>(
            <div key={l.screen} onClick={()=>onNavigate(l.screen)} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid #F8FAFC",cursor:"pointer"}}
              onMouseEnter={e=>e.currentTarget.style.opacity=".7"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
              <span style={{fontSize:15,width:20,textAlign:"center"}}>{l.icon}</span>
              <span style={{fontSize:13,fontWeight:600,color:"#0F172A",flex:1}}>{l.label}</span>
              <span style={{color:"#CBD5E0"}}>›</span>
            </div>
          ))}
        </div>
      </div>
    </div>

  </div>;
}

function HubScreen({progress,onStartLesson}){
  const isMobile=useIsMobile();
  const[search,setSearch]=useState("");
  const[showBeyond,setShowBeyond]=useState(false);
  const track=getTrack();
  // A real path per goal: which levels are on the path (in order) vs. optional "beyond".
  const path = track.id==="clb5"
    ? {levels:["foundation","a1","a2","b1"], beyond:["b2","clb"]}
    : {levels:["foundation","a1","a2","b1","b2","clb"], beyond:[]};
  const pathLevels = path.levels.map(id=>SYLLABUS[id]).filter(Boolean);
  const beyondLevels = path.beyond.map(id=>SYLLABUS[id]).filter(Boolean);
  const allLessons=Object.values(SYLLABUS).flatMap(lv=>lv.modules.flatMap(m=>m.lessons));
  const pathLessons=pathLevels.flatMap(lv=>lv.modules.flatMap(m=>m.lessons));
  const pathDone=pathLessons.filter(l=>progress[l.id]).length;
  const goalPct=Math.round((pathDone/Math.max(pathLessons.length,1))*100);
  const nextLesson=pathLessons.find(l=>!progress[l.id]) || allLessons.find(l=>!progress[l.id]);
  const nextLevel=Object.values(SYLLABUS).find(lv=>lv.modules.flatMap(m=>m.lessons).some(l=>l.id===nextLesson?.id));
  const currentLevel=pathLevels.find(lv=>lv.modules.flatMap(m=>m.lessons).some(l=>!progress[l.id])) || pathLevels[0];
  const[expanded,setExpanded]=useState(currentLevel?.id || Object.keys(SYLLABUS)[0]);

  return <div style={{padding:isMobile?"10px":"20px 28px",maxWidth:760,margin:"0 auto"}}>

    {/* Path header — your goal + progress toward it */}
    <div style={{background:"#0F172A",borderRadius:14,padding:"14px 16px",marginBottom:12}}>
      <div style={{fontSize:11,color:"rgba(255,255,255,0.55)",fontWeight:600,marginBottom:5}}>{track.emoji} Your {track.label} path{track.clb?` · goal CLB ${track.clb}`:""}</div>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:14,fontWeight:700,color:"#fff",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{nextLesson?`Next: ${nextLesson.title}`:"Path complete! 🎉"}</div>
          <div style={{height:6,background:"rgba(255,255,255,0.15)",borderRadius:99,marginTop:8,overflow:"hidden"}}><div style={{height:"100%",width:`${goalPct||2}%`,background:"linear-gradient(90deg,#3B82F6,#10B981)",borderRadius:99,transition:"width 0.8s"}}/></div>
          <div style={{fontSize:10,color:"rgba(255,255,255,0.45)",marginTop:5}}>{pathDone}/{pathLessons.length} lessons on your path · {goalPct}%</div>
        </div>
        {nextLesson&&nextLevel&&<button onClick={()=>onStartLesson(nextLesson,nextLevel)}
          style={{background:"#fff",color:"#0F172A",border:"none",padding:"10px 18px",borderRadius:10,fontFamily:"system-ui,sans-serif",fontWeight:800,fontSize:13,cursor:"pointer",flexShrink:0}}>
          Continue →
        </button>}
      </div>
    </div>

    {/* Due for review — spaced-repetition nudge (the strongest retention lever) */}
    {(()=>{
      const dueIds=getDueReviewIds(progress);
      if(!dueIds.length) return null;
      const dueLessons=dueIds.map(id=>allLessons.find(l=>l.id===id)).filter(Boolean);
      if(!dueLessons.length) return null;
      const first=dueLessons[0];
      const lvl=Object.values(SYLLABUS).find(lv=>lv.modules.flatMap(m=>m.lessons).some(l=>l.id===first.id));
      const n=dueLessons.length;
      return <div onClick={()=>onStartLesson(first,lvl)}
        style={{display:"flex",alignItems:"center",gap:12,background:"#FFFBEB",border:"1.5px solid #FDE68A",borderRadius:14,padding:"12px 14px",marginBottom:12,cursor:"pointer"}}>
        <div style={{fontSize:24,lineHeight:1}}>🧠</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:800,color:"#92400E"}}>{n} {n===1?"lesson":"lessons"} ready for review</div>
          <div style={{fontSize:11,color:"#B45309",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>Refresh now so it sticks — start with “{first.title}”.</div>
        </div>
        <span style={{background:"#92400E",color:"#fff",borderRadius:8,padding:"8px 14px",fontSize:12,fontWeight:800,flexShrink:0}}>Review →</span>
      </div>;
    })()}

    {/* Search */}
    <div style={{position:"relative",marginBottom:12}}>
      <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:14}}>🔍</span>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search lessons..."
        style={{width:"100%",padding:"10px 12px 10px 36px",borderRadius:10,border:"1.5px solid #E2E8F0",fontSize:13,color:"#0F172A",background:"#fff",outline:"none",boxSizing:"border-box",fontFamily:"system-ui,sans-serif"}}/>
      {search&&<button onClick={()=>setSearch("")} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",fontSize:14,cursor:"pointer",color:"#94A3B8"}}>✕</button>}
    </div>

    {/* Search results */}
    {search.length>1&&<div style={{marginBottom:12}}>
      {(()=>{
        const q=search.toLowerCase();
        const results=allLessons.filter(l=>l.title.toLowerCase().includes(q));
        const lv=(l)=>Object.values(SYLLABUS).find(lv=>lv.modules.flatMap(m=>m.lessons).some(x=>x.id===l.id));
        return results.length?results.slice(0,6).map(l=>{
          const lvl=lv(l); const done=!!progress[l.id];
          return <div key={l.id} onClick={()=>onStartLesson(l,lvl)}
            style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:10,border:"1px solid #E2E8F0",background:"#fff",cursor:"pointer",marginBottom:6}}>
            <div style={{width:28,height:28,borderRadius:7,background:done?"#10B981":"#0F172A",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:11,fontWeight:700,flexShrink:0}}>{done?"✓":"▶"}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:600,color:"#0F172A",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{l.title}</div>
              <div style={{fontSize:11,color:"#94A3B8"}}>{lvl?.label} · {l.skill} · {l.mins}min</div>
            </div>
            <span style={{fontSize:11,color:done?"#10B981":"#64748B",fontWeight:600,flexShrink:0}}>{done?"Done":"Go →"}</span>
          </div>;
        }):<div style={{textAlign:"center",padding:"16px",color:"#94A3B8",fontSize:13}}>No results for "{search}"</div>;
      })()}
    </div>}

    {/* Your path: levels in order, a goal milestone, then optional levels beyond your goal */}
    {(()=>{
      const renderLevel=(level)=>{
      const lLessons=level.modules.flatMap(m=>m.lessons);
      const donePct=Math.round((lLessons.filter(l=>progress[l.id]).length/lLessons.length)*100);
      const doneCount=lLessons.filter(l=>progress[l.id]).length;
      const isOpen=expanded===level.id;
      return <div key={level.id} style={{marginBottom:8,background:"#fff",borderRadius:12,border:isOpen?`1.5px solid #0F172A`:"1.5px solid #E2E8F0",overflow:"hidden"}}>
        {/* Level header */}
        <div onClick={()=>setExpanded(isOpen?null:level.id)}
          style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",cursor:"pointer"}}>
          <span style={{fontSize:20,flexShrink:0}}>{level.emoji}</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:700,color:"#0F172A"}}>{level.label}</div>
            <div style={{fontSize:11,color:"#94A3B8"}}>{doneCount}/{lLessons.length} lessons · {level.cefrTag}</div>
          </div>
          <div style={{fontSize:12,fontWeight:700,color:donePct>0?"#10B981":"#94A3B8",marginRight:4}}>{donePct}%</div>
          <span style={{fontSize:14,color:"#94A3B8",transform:isOpen?"rotate(180deg)":"none",transition:"transform 0.2s",display:"inline-block"}}>⌄</span>
        </div>
        {/* Progress bar */}
        {isOpen&&<div style={{height:2,background:"#F1F5F9",margin:"0 14px"}}><div style={{height:"100%",width:`${donePct||1}%`,background:"#0F172A",transition:"width 0.5s"}}/></div>}
        {/* Lessons list */}
        {isOpen&&<div style={{padding:"8px 10px"}}>
          {level.modules.map(mod=><div key={mod.id} style={{marginBottom:8}}>
            <div style={{fontSize:10,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:.5,padding:"4px 4px 6px"}}>{mod.title}</div>
            {mod.lessons.map((lesson,li)=>{
              const done=!!progress[lesson.id];
              const isNext=!done&&mod.lessons.slice(0,li).every(l=>progress[l.id]);
              // Apple won't see a lock icon on iOS — all lessons are free in iOS build.
              const locked=!isLessonFree(lesson.id) && !isPremiumUnlocked();
              const icon={listening:"🎧",speaking:"🗣️",reading:"📖",writing:"✍️"}[lesson.skill]||"📚";
              return <div key={lesson.id} onClick={()=>onStartLesson(lesson,level)}
                style={{display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:9,cursor:"pointer",marginBottom:4,background:done?"#F0FDF4":isNext&&!locked?"#F8FAFC":"transparent",border:isNext&&!locked?"1px solid #E2E8F0":"1px solid transparent"}}>
                <div style={{width:28,height:28,borderRadius:7,background:locked?"#F1F5F9":done?"#10B981":isNext?"#0F172A":"#F1F5F9",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:locked?"#94A3B8":done||isNext?"#fff":"#64748B",fontWeight:700,flexShrink:0}}>
                  {locked?"🔒":done?"✓":icon}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:600,color:locked?"#94A3B8":"#0F172A",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{lesson.title}</div>
                  <div style={{fontSize:10,color:"#94A3B8"}}>{lesson.mins}min · {lesson.questions.length}q</div>
                </div>
                <span style={{fontSize:11,fontWeight:700,color:done?"#10B981":isNext?"#0F172A":locked?"#F59E0B":"#94A3B8",flexShrink:0}}>
                  {done?"✓":locked?"⭐":isNext?"Start":"→"}
                </span>
              </div>;
            })}
          </div>)}
        </div>}
      </div>;
      };
      const milestone = track.clb ? <div style={{background:"linear-gradient(135deg,#ECFDF5,#D1FAE5)",border:"1.5px solid #6EE7B7",borderRadius:12,padding:"14px 16px",marginBottom:8,display:"flex",alignItems:"center",gap:12}}>
        <span style={{fontSize:26}}>🎓</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:800,color:"#065F46"}}>Finish these and you're CLB {track.clb} ready</div>
          <div style={{fontSize:11,color:"#047857"}}>Then take the {track.exam||"TEF"} mock to confirm it.</div>
        </div>
        <div style={{fontSize:14,fontWeight:800,color:"#059669",flexShrink:0}}>{goalPct}%</div>
      </div> : null;
      return <>
        {pathLevels.map(renderLevel)}
        {milestone}
        {beyondLevels.length>0 && <>
          <button onClick={()=>setShowBeyond(s=>!s)} style={{width:"100%",background:"#fff",border:"1.5px dashed #CBD5E0",borderRadius:12,padding:"12px 14px",marginBottom:8,cursor:"pointer",display:"flex",alignItems:"center",gap:10,color:"#64748B",fontWeight:700,fontSize:13,fontFamily:"system-ui,sans-serif"}}>
            <span style={{fontSize:16}}>✨</span>
            <span style={{flex:1,textAlign:"left"}}>Beyond your goal — keep going to CLB 7+ (optional)</span>
            <span>{showBeyond?"▲":"▼"}</span>
          </button>
          {showBeyond && beyondLevels.map(renderLevel)}
        </>}
      </>;
    })()}
  </div>;
}

// Vocab flip cards — extracted so hooks aren't called inside .map()
// ─── FRENCH TTS ──────────────────────────────────────────────────────────────
// Primary: ElevenLabs (real French voice) via our serverless proxy /api/tts.
// Fallback: the browser/device Web Speech API (used if offline or the proxy is
// unconfigured). The CDN caches each unique line, so audio is fast after first play.
const TTS_URL = "https://www.franco.app/api/tts";
const _ttsCache = new Map();   // text -> object URL (per session)
let _ttsAudio = null;          // currently-playing <audio>
let _ttsElevenOk = true;       // flips false if the proxy is unavailable, to stop retrying

function stopFrench(){
  try{ if(_ttsAudio){ _ttsAudio.pause(); _ttsAudio.currentTime=0; } }catch{}
  try{ window.speechSynthesis?.cancel(); }catch{}
}
function _deviceTTS(cleaned){
  if(!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(cleaned);
  utt.lang = "fr-CA"; utt.rate = 0.9; utt.pitch = 1;
  const voices = window.speechSynthesis.getVoices();
  const frVoice = voices.find(v=>v.lang?.startsWith("fr-CA"))
    || voices.find(v=>v.lang?.startsWith("fr-FR"))
    || voices.find(v=>v.lang?.startsWith("fr"));
  if(frVoice) utt.voice = frVoice;
  window.speechSynthesis.speak(utt);
}
function _playUrl(url){
  try{
    const a = new Audio(url);
    _ttsAudio = a;
    // Release the element reference once playback finishes so detached <audio>
    // nodes can be garbage-collected instead of piling up over a session.
    a.onended = a.onerror = ()=>{ if(_ttsAudio===a) _ttsAudio=null; };
    a.play().catch(()=>{});
    return true;
  }catch{ return false; }
}
// Keep the per-session blob cache bounded so object URLs don't accumulate
// without limit on long study sessions. Oldest entries are revoked + dropped.
const _TTS_CACHE_MAX = 60;
function _cacheTts(key, url){
  _ttsCache.set(key, url);
  while(_ttsCache.size > _TTS_CACHE_MAX){
    const oldest = _ttsCache.keys().next().value;
    const old = _ttsCache.get(oldest);
    _ttsCache.delete(oldest);
    try{ URL.revokeObjectURL(old); }catch{}
  }
}
async function speakFrench(text){
  if(!text) return;
  // Strip parenthetical English glosses before speaking.
  const cleaned = String(text).replace(/\(.*?\)/g,"").replace(/[()→]/g,"").trim();
  if(!cleaned) return;
  stopFrench();
  // Cached object URL from this session?
  if(_ttsCache.has(cleaned)){ if(_playUrl(_ttsCache.get(cleaned))) return; }
  if(_ttsElevenOk && typeof fetch==="function"){
    try{
      const res = await fetch(`${TTS_URL}?text=${encodeURIComponent(cleaned)}`);
      if(res.ok){
        const blob = await res.blob();
        if(blob && blob.size>0 && blob.type.includes("audio")){
          const url = URL.createObjectURL(blob);
          _cacheTts(cleaned, url);
          if(_playUrl(url)) return;
        }
      } else if(res.status===503){
        // Proxy not configured (no key) — stop hammering it this session.
        _ttsElevenOk = false;
      }
    }catch{ /* network/offline — fall through to device TTS */ }
  }
  _deviceTTS(cleaned);
}

// Speak English narration (lesson "story", explanations) using the device voice.
// Kept separate from speakFrench so we don't burn ElevenLabs credits on English
// and so the accent is correct (en-CA).
function speakEnglish(text){
  if(!text) return;
  const cleaned = String(text).replace(/\s+/g," ").trim();
  if(!cleaned) return;
  stopFrench();
  if(!('speechSynthesis' in window)) return;
  try{
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(cleaned);
    utt.lang = "en-CA"; utt.rate = 0.95; utt.pitch = 1;
    const voices = window.speechSynthesis.getVoices();
    const enVoice = voices.find(v=>v.lang?.startsWith("en-CA"))
      || voices.find(v=>v.lang?.startsWith("en-US"))
      || voices.find(v=>v.lang?.startsWith("en"));
    if(enVoice) utt.voice = enVoice;
    window.speechSynthesis.speak(utt);
  }catch{}
}

// Speak a line in Sophie's ElevenLabs voice AND expose the live audio level so a
// portrait can "talk" (mouth/lean animation). Returns a stop() function.
// onLevel(0..1) fires every frame; onEnd() fires when she finishes.
// Falls back to device TTS (no real levels — we fake a gentle pulse) if the
// ElevenLabs proxy is unavailable.
// Reuse ONE Audio element (unlocked by a user tap) so iOS lets ElevenLabs audio
// play even after an async AI call. Animation is driven by a lively timed pulse
// (no Web Audio analyser — that path is flaky on iOS and forced the device-voice
// fallback). v1 "moving portrait"; real lip-sync is a future improvement.
function speakSophie(text, { onLevel = () => {}, onEnd = () => {}, audioEl = null } = {}) {
  let stopped = false, raf, t = 0;
  const el = audioEl || new Audio();
  const cleanup = () => {
    stopped = true;
    try { cancelAnimationFrame(raf); } catch {}
    try { el.pause(); } catch {}
    try { if (el.src && el.src.startsWith("blob:")) URL.revokeObjectURL(el.src); } catch {}
    try { window.speechSynthesis?.cancel(); } catch {}
    onLevel(0);
  };
  const cleaned = String(text || "").replace(/\(.*?\)/g, "").replace(/[()→]/g, "").trim();
  if (!cleaned) { onEnd(); return cleanup; }

  // Lively talking pulse for the portrait while she speaks.
  const pulse = () => { if (stopped) return; t += 0.3; onLevel(Math.min(1, 0.45 + 0.35*Math.abs(Math.sin(t)) + 0.2*Math.abs(Math.sin(t*2.7)))); raf = requestAnimationFrame(pulse); };

  const deviceFallback = () => {
    if (!("speechSynthesis" in window)) { onEnd(); return; }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(cleaned);
      u.lang = "fr-CA"; u.rate = 0.92; u.pitch = 1.08;
      const vs = window.speechSynthesis.getVoices();
      const female = vs.find(v => v.lang?.startsWith("fr") && /amélie|amelie|audrey|marie|chantal|aurélie|female|femme/i.test(v.name));
      const v = female || vs.find(v => v.lang?.startsWith("fr-CA")) || vs.find(v => v.lang?.startsWith("fr"));
      if (v) u.voice = v;
      u.onstart = () => pulse();
      u.onend = () => { onLevel(0); onEnd(); };
      window.speechSynthesis.speak(u);
    } catch { onEnd(); }
  };

  (async () => {
    try {
      const res = await fetch(`${TTS_URL}?text=${encodeURIComponent(cleaned)}`);
      if (!res.ok) throw new Error("tts");
      const blob = await res.blob();
      if (!blob || blob.size === 0 || !blob.type.includes("audio")) throw new Error("tts-empty");
      if (stopped) return;
      const url = URL.createObjectURL(blob);
      el.src = url;
      el.onended = () => { try { URL.revokeObjectURL(url); } catch {} cleanup(); onEnd(); };
      pulse();
      await el.play();   // works because `el` was unlocked by the Start tap
    } catch {
      if (!stopped) deviceFallback();
    }
  })();

  return cleanup;
}

function SpeakBtn({text, size=14, style={}}){
  const[speaking,setSpeaking]=useState(false);
  const handle=(e)=>{
    e.stopPropagation();
    setSpeaking(true);
    speakFrench(text);
    setTimeout(()=>setSpeaking(false), Math.max(800, text.length*60));
  };
  return(
    <button onClick={handle} title="Listen in French"
      style={{background:"none",border:"none",cursor:"pointer",padding:"2px 4px",
        fontSize:size,lineHeight:1,borderRadius:6,transition:"transform 0.15s",
        transform:speaking?"scale(1.3)":"scale(1)",opacity:speaking?1:0.65,...style}}>
      {speaking?"🔊":"🔈"}
    </button>
  );
}

function VocabFlipList({vocab}){
  const[flipped,setFlipped]=useState(()=>vocab.map(()=>false));
  const toggle=(i)=>setFlipped(f=>{const n=[...f];n[i]=!n[i];return n;});
  return <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
    {vocab.map((v,i)=>{
      const parts=v.split(/[()]/);
      const hasTrans=parts.length>1;
      const isFlipped=flipped[i];
      const frWord = parts[0].trim();
      return <div key={i} style={{display:"flex",alignItems:"center",gap:4,
          fontSize:13,fontWeight:600,padding:"6px 10px 6px 14px",borderRadius:50,
          background:isFlipped?T.navy:T.blueLight,color:isFlipped?"#fff":T.navy,
          fontStyle:"italic",transition:"all 0.25s",border:`1.5px solid ${isFlipped?T.navy:"transparent"}`}}>
        <span onClick={()=>hasTrans&&toggle(i)} style={{cursor:hasTrans?"pointer":"default"}}>
          {isFlipped&&hasTrans?<><span style={{fontSize:10,marginRight:4}}>🔄</span>{parts[1]?.trim()||v}</>:<>{v}{hasTrans&&<span style={{fontSize:10,marginLeft:4,opacity:0.5}}>tap</span>}</>}
        </span>
        <SpeakBtn text={frWord} size={13} style={{color:isFlipped?"rgba(255,255,255,0.8)":T.navy}}/>
      </div>;
    })}
  </div>;
}

// Parse a lesson's vocab list ("Bonjour (bohn-ZHOOR) = Hello / Good day")
// into clean {fr, en} pairs we can build extra practice questions from.
function parseVocabPairs(vocab){
  if(!Array.isArray(vocab)) return [];
  const pairs=[];
  for(const raw of vocab){
    if(typeof raw!=="string"||!raw.includes("=")) continue;
    const idx=raw.indexOf("=");
    const fr=raw.slice(0,idx).replace(/\([^)]*\)/g,"").trim();
    const enFull=raw.slice(idx+1).trim();
    const en=enFull.split("/")[0].split(",")[0].trim();
    if(fr&&en&&en.length<=42) pairs.push({fr,en,enFull});
  }
  // de-dupe by French word
  const seen=new Set();
  return pairs.filter(p=>{const k=p.fr.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});
}

// Auto-generate extra vocabulary practice so every lesson has more questions to
// lock the words in. Returns a small set of tap + match questions built from the
// lesson's own vocab — no per-lesson authoring needed.
function buildVocabPractice(lesson){
  const pairs=parseVocabPairs(lesson?.vocab);
  if(pairs.length<4) return [];
  const shuffle=(a)=>{const x=[...a];for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x;};
  const out=[];
  const mPairs=shuffle(pairs).slice(0,5).map(p=>[p.fr,p.en]);
  out.push({type:"match",prompt:"Extra practice — match the French to its meaning",pairs:mPairs,explain:"Quick review of today's words. Say each one out loud as you match it — that's how they stick.",diff:2,_gen:true});
  const picks=shuffle(pairs).slice(0,Math.min(4,pairs.length));
  for(const p of picks){
    const distractors=shuffle(pairs.filter(q=>q.en!==p.en)).slice(0,3).map(q=>q.en);
    if(distractors.length<3) continue;
    const opts=shuffle([p.en,...distractors]);
    out.push({type:"tap",fr:p.fr,opts,correct:opts.indexOf(p.en),explain:`${p.fr} = ${p.enFull}. Keep practising today's words until they come automatically.`,diff:1,_gen:true});
  }
  return out;
}

// ─── LIVE VIDEO CALL WITH SOPHIE (HeyGen Interactive Avatar) ──────────────────
// Real-time avatar lesson: Sophie's face speaks, the student talks back over the
// mic, and her replies are generated by our EXISTING Sophie brain (callClaude +
// buildSophieSystemPrompt) with the lesson's context. The HeyGen SDK loads
// lazily (vite-ignored), so the web build doesn't need the package until it's
// installed on your machine.
//
// TO TURN THIS ON (all three, then it can even ship over-the-air via Capgo):
//   1. npm i @heygen/streaming-avatar
//   2. Set HEYGEN_API_KEY in Vercel (see api/heygen-token.js)
//   3. Put YOUR Interactive Avatar id in HEYGEN_AVATAR_ID below, then set
//      HEYGEN_ENABLED = true.
// NOTE: HeyGen now also offers @heygen/liveavatar-web-sdk (the streaming-avatar
//   package is being deprecated) — if you migrate, only this file changes.
// Flip true once: (1) you've created a HeyGen Photo/Interactive Avatar of Sophie
// and pasted its STREAMING avatar id below, (2) HEYGEN_API_KEY is set in Vercel,
// (3) npm i @heygen/streaming-avatar. Until then the floating button uses the
// free owned animation. The live HeyGen call is PREMIUM-ONLY (per-minute cost).
const HEYGEN_ENABLED = false;
const HEYGEN_AVATAR_ID = "REPLACE_WITH_YOUR_INTERACTIVE_AVATAR_ID"; // HeyGen → Interactive Avatar → your Sophie photo-avatar id
const HEYGEN_TOKEN_URL = "https://www.franco.app/api/heygen-token";

function LessonVideoCall({ lesson, learner, onClose }){
  const videoRef = useRef(null);
  const avatarRef = useRef(null);
  const [status, setStatus] = useState("connecting"); // connecting|live|speaking|ended|error
  const [error, setError] = useState("");
  const [caption, setCaption] = useState("");
  const sysPrompt = useMemo(()=> buildSophieSystemPrompt({ learner, lesson }), [learner, lesson]);

  useEffect(()=>{
    let mounted = true;
    (async ()=>{
      try{
        const tRes = await fetch(HEYGEN_TOKEN_URL);
        if(!tRes.ok) throw new Error("token");
        const { token } = await tRes.json();
        if(!token) throw new Error("token");
        const mod = "@heygen/streaming-avatar";
        const SA = await import(/* @vite-ignore */ mod);
        const StreamingAvatar = SA.default;
        const { AvatarQuality, StreamingEvents, TaskType } = SA;
        const avatar = new StreamingAvatar({ token });
        avatarRef.current = avatar;

        avatar.on(StreamingEvents.STREAM_READY, (e)=>{
          if(videoRef.current && e.detail){ videoRef.current.srcObject = e.detail; videoRef.current.play?.().catch(()=>{}); }
          if(mounted) setStatus("live");
        });
        avatar.on(StreamingEvents.AVATAR_START_TALKING, ()=>{ if(mounted) setStatus("speaking"); });
        avatar.on(StreamingEvents.AVATAR_STOP_TALKING, ()=>{ if(mounted) setStatus("live"); });
        avatar.on(StreamingEvents.STREAM_DISCONNECTED, ()=>{ if(mounted) setStatus("ended"); });
        avatar.on(StreamingEvents.USER_END_MESSAGE, async (e)=>{
          const said = (e?.detail?.message || "").trim();
          if(!said) return;
          if(mounted) setCaption("You: " + said);
          const reply = aiClean(await callClaude(sysPrompt, said, 180));
          if(!mounted) return;
          setCaption("Sophie: " + reply);
          try{ await avatar.speak({ text: reply, taskType: TaskType.REPEAT }); }catch{}
        });

        await avatar.createStartAvatar({ avatarName: HEYGEN_AVATAR_ID, quality: AvatarQuality.Low, language: "fr" });
        try{ await avatar.startVoiceChat({ useSilencePrompt: false }); }catch{}
        const openerPrompt = lesson
          ? `Greet the student warmly by voice and introduce today's lesson "${lesson.title}" in 2-3 short sentences, mixing simple French with English. End by inviting them to repeat after you or ask anything.`
          : `Greet the student warmly by voice as their French teacher Sophie, in 2-3 short sentences, mixing simple French with English. Invite them to ask anything or practise speaking.`;
        const opener = aiClean(await callClaude(sysPrompt, openerPrompt, 180));
        if(mounted){ try{ await avatar.speak({ text: opener, taskType: TaskType.REPEAT }); }catch{} }
      }catch(e){
        if(mounted){ setError("Couldn't start the live call. Check your connection and try again."); setStatus("error"); }
      }
    })();
    return ()=>{ mounted = false; try{ avatarRef.current?.stopAvatar?.(); }catch{} };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const hangUp = ()=>{ try{ avatarRef.current?.stopAvatar?.(); }catch{} onClose(); };

  return <div style={{position:"fixed",inset:0,background:"#0B1020",zIndex:300,display:"flex",flexDirection:"column"}}>
    <div style={{flex:1,position:"relative",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}}>
      <video ref={videoRef} autoPlay playsInline style={{width:"100%",height:"100%",objectFit:"cover",background:"#0B1020"}}/>
      {status!=="live"&&status!=="speaking"&&<div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,color:"#fff",textAlign:"center",padding:24}}>
        <div style={{fontSize:44}}>{status==="error"?"😕":"📹"}</div>
        <div style={{fontSize:15,fontWeight:700,maxWidth:300}}>
          {status==="connecting"?"Connecting you with Sophie…":status==="ended"?"Call ended":status==="error"?error:"…"}
        </div>
        {(status==="error"||status==="ended")&&<button onClick={hangUp} style={{marginTop:6,background:"#3B82F6",color:"#fff",border:"none",borderRadius:10,padding:"10px 20px",fontWeight:700,cursor:"pointer"}}>Close</button>}
      </div>}
      <div style={{position:"absolute",top:0,left:0,right:0,padding:"calc(env(safe-area-inset-top) + 10px) 16px 10px",display:"flex",alignItems:"center",gap:8,background:"linear-gradient(180deg,rgba(0,0,0,0.5),transparent)"}}>
        <div style={{width:9,height:9,borderRadius:"50%",background:(status==="speaking"||status==="live")?"#10B981":"#F59E0B"}}/>
        <div style={{color:"#fff",fontSize:13,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>Sophie · {lesson?.title || "Live"}</div>
      </div>
      {caption&&(status==="live"||status==="speaking")&&<div style={{position:"absolute",left:16,right:16,bottom:20,background:"rgba(0,0,0,0.55)",color:"#fff",borderRadius:12,padding:"10px 14px",fontSize:14,lineHeight:1.5,textAlign:"center"}}>{caption}</div>}
    </div>
    <div style={{padding:"14px 16px calc(env(safe-area-inset-bottom) + 14px)",display:"flex",justifyContent:"center",background:"#0B1020"}}>
      <button onClick={hangUp} style={{background:"#EF4444",color:"#fff",border:"none",borderRadius:50,padding:"14px 28px",fontSize:15,fontWeight:800,cursor:"pointer"}}>✕ End call</button>
    </div>
  </div>;
}

// ─── MID-LESSON PROGRESS (resume where you left off) ──────────────────────────
// Saves the learner's position + score inside a lesson so leaving / going back
// (or the app closing) doesn't lose their work. Cleared when the lesson is
// completed. Not used for ungraded "practice" sets.
function readLessonProg(id){ try{ return JSON.parse(localStorage.getItem("franco_lprog_"+id)||"null"); }catch{ return null; } }
function writeLessonProg(id, data){ try{ localStorage.setItem("franco_lprog_"+id, JSON.stringify(data)); }catch{} }
function clearLessonProg(id){ try{ localStorage.removeItem("franco_lprog_"+id); }catch{} }

// Build a mid-lesson vocab mini-game ("Word Rush") from the lesson's own words.
// Returns a {type:"minigame"} pseudo-question, or null if there isn't enough vocab.
function buildMiniGame(lesson){
  const pairs=parseVocabPairs(lesson?.vocab);
  if(pairs.length<4) return null;
  return { type:"minigame", pairs, _gen:true };
}

// ⚡ WORD RUSH — a fast, combo-driven vocab game dropped into the middle of a
// lesson for variety. Rapid-fire: see a French word, tap its meaning before the
// clock ticks up; correct answers build a combo. Pure delight, no penalty.
function MiniGameQuestion({pairs, onComplete}){
  const rounds = useMemo(()=>{
    const sh=(a)=>{const x=[...a];for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x;};
    return sh(pairs).slice(0,Math.min(6,pairs.length)).map(p=>{
      const distract=sh(pairs.filter(q=>q.en!==p.en)).slice(0,3).map(q=>q.en);
      return { fr:p.fr, en:p.en, opts:sh([p.en,...distract]) };
    });
  },[pairs]);
  const[idx,setIdx]=useState(0);
  const[combo,setCombo]=useState(0);
  const[best,setBest]=useState(0);
  const[score,setScore]=useState(0);
  const[flash,setFlash]=useState(null); // {i, ok}
  const[elapsed,setElapsed]=useState(0);
  const[finished,setFinished]=useState(false);
  const startRef=useRef(Date.now());
  useEffect(()=>{
    if(finished) return undefined;
    const t=setInterval(()=>setElapsed(Math.floor((Date.now()-startRef.current)/1000)),250);
    return()=>clearInterval(t);
  },[finished]);
  const r=rounds[idx];
  const pick=(i)=>{
    if(flash||finished) return;
    const ok=r.opts[i]===r.en;
    setFlash({i,ok});
    try{ ok?celebrateCorrect():commiserateWrong(); }catch{}
    speakFrench(r.fr);
    setTimeout(()=>{
      if(ok){ setScore(s=>s+1); setCombo(c=>{const n=c+1; setBest(b=>Math.max(b,n)); return n;}); }
      else { setCombo(0); }
      setFlash(null);
      if(idx<rounds.length-1) setIdx(v=>v+1);
      else setFinished(true);
    }, ok?420:620);
  };
  if(!rounds.length) return null;

  if(finished){
    const perfect=score===rounds.length;
    return <div style={{background:"linear-gradient(135deg,#1E1B4B,#312E81)",borderRadius:16,padding:"24px 20px",textAlign:"center",color:"#fff"}}>
      <div style={{fontSize:48}}>{perfect?"🏆":score>=rounds.length*0.6?"⚡":"💪"}</div>
      <div style={{fontFamily:"Georgia,serif",fontSize:20,fontWeight:800,marginTop:6}}>{perfect?"Perfect Rush!":"Word Rush complete!"}</div>
      <div style={{display:"flex",gap:10,margin:"16px 0",justifyContent:"center"}}>
        {[{v:`${score}/${rounds.length}`,l:"Correct"},{v:`${best}x`,l:"Best combo"},{v:`${elapsed}s`,l:"Time"}].map(s=>(
          <div key={s.l} style={{background:"rgba(255,255,255,0.1)",borderRadius:12,padding:"10px 14px",minWidth:72}}>
            <div style={{fontSize:18,fontWeight:800}}>{s.v}</div>
            <div style={{fontSize:10,opacity:0.7,marginTop:2}}>{s.l}</div>
          </div>
        ))}
      </div>
      <button onClick={()=>onComplete(score)} style={{background:"#fff",color:"#312E81",border:"none",borderRadius:12,padding:"13px 28px",fontWeight:800,fontSize:14,cursor:"pointer",width:"100%"}}>Continue →</button>
    </div>;
  }

  return <div style={{background:"linear-gradient(135deg,#1E1B4B,#312E81)",borderRadius:16,padding:"18px",color:"#fff"}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
      <div style={{fontSize:13,fontWeight:800,letterSpacing:.5}}>⚡ WORD RUSH</div>
      <div style={{display:"flex",gap:10,alignItems:"center",fontSize:12}}>
        {combo>=2&&<span style={{background:"#F59E0B",color:"#fff",borderRadius:50,padding:"3px 10px",fontWeight:800}}>🔥 {combo}x combo</span>}
        <span style={{opacity:0.75}}>⏱ {elapsed}s</span>
        <span style={{opacity:0.75}}>{idx+1}/{rounds.length}</span>
      </div>
    </div>
    <div style={{background:"rgba(255,255,255,0.08)",borderRadius:12,padding:"18px",textAlign:"center",marginBottom:14}}>
      <div style={{fontSize:11,opacity:0.6,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>What does this mean?</div>
      <div style={{fontFamily:"Georgia,serif",fontSize:26,fontWeight:800,fontStyle:"italic"}}>{r.fr}</div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      {r.opts.map((o,i)=>{
        const isFlash=flash&&flash.i===i;
        const bg=isFlash?(flash.ok?"#10B981":"#EF4444"):"rgba(255,255,255,0.12)";
        return <button key={i} onClick={()=>pick(i)} disabled={!!flash}
          style={{background:bg,color:"#fff",border:"1.5px solid rgba(255,255,255,0.15)",borderRadius:12,padding:"14px 10px",fontSize:14,fontWeight:700,cursor:flash?"default":"pointer",transition:"background 0.15s",minHeight:52}}>
          {o}
        </button>;
      })}
    </div>
  </div>;
}

function LessonScreen({lesson,level,companion,onComplete,onDone,onBack,onPracticeWithSophie}){
  const c=companion||COMPANIONS[0];
  const isMobile=useIsMobile();

  // ── State ──
  // Resume in-progress lessons: if the learner left part-way through, pick up at
  // their saved question with their score intact (graded lessons only).
  const resumedRef = useRef(lesson.practice ? null : readLessonProg(lesson.id));
  const resumed = resumedRef.current;
  const[phase,setPhase]=useState(lesson.practice?"questions":(resumed&&resumed.qIdx>0?"questions":"recap")); // recap | teach | questions | review | done
  const[showCall,setShowCall]=useState(false); // HeyGen live "video call with Sophie"
  const[teachSlide,setTeachSlide]=useState(0);
  const[recapDone,setRecapDone]=useState(false);
  const[qIdx,setQIdx]=useState(resumed?.qIdx||0);
  const[selected,setSelected]=useState(null);
  const[answered,setAnswered]=useState(false);
  const[correct,setCorrect]=useState(resumed?.correct||0);
  const[xp,setXp]=useState(resumed?.xp||0);
  const[wrongQueue,setWrongQueue]=useState([]); // questions to review at end
  const[reviewIdx,setReviewIdx]=useState(0);
  const[matchSel,setMatchSel]=useState(null); // {side:'fr'|'en', idx}
  const[matchDone,setMatchDone]=useState([]);
  const[matchWrong,setMatchWrong]=useState([]);
  const[orderPlaced,setOrderPlaced]=useState([]);
  const[orderBank,setOrderBank]=useState([]);
  const[showConfetti,setShowConfetti]=useState(false);
  const[speaking,setSpeaking]=useState(false);
  const[speakResult,setSpeakResult]=useState(null);
  const streak=parseInt(localStorage.getItem("franco_streak")||"0");

  // Beginner lessons (Foundation / A1 / A2) play stage-by-stage: easiest first,
  // hardest last (stable sort). Upper tiers (B1/B2/CLB) keep their authored order,
  // which is deliberately skill-sequenced (e.g. listen first, then a written reflection).
  const questions = useMemo(()=>{
    const raw = lesson.questions||[];
    const extra = buildVocabPractice(lesson);
    let all = [...raw, ...extra];
    const isBeginner = /^(f|a1|a2)-/.test(lesson.id||"");
    if(isBeginner){
      all = all
        .map((x,i)=>[x,i])
        .sort((a,b)=>((a[0].diff||2)-(b[0].diff||2))||(a[1]-b[1]))
        .map(p=>p[0]);
    }
    // Pilot: drop a "Word Rush" mini-game into the middle of Foundation lessons.
    if(/^f-/.test(lesson.id||"")){
      const game = buildMiniGame(lesson);
      if(game && all.length>=2){
        const mid = Math.floor(all.length/2);
        all = [...all.slice(0,mid), game, ...all.slice(mid)];
      }
    }
    return all;
  },[lesson]);
  const recapQs = lesson.recap ?
    (lesson.recap.flatMap(lid => {
      const prev = [...(FOUNDATION_LESSONS||[]),...(A1_LESSONS||[]),...(A2_LESSONS||[]),...(B1_LESSONS||[])].find(l=>l.id===lid);
      return prev ? (prev.questions||[]).slice(0,2) : [];
    })).slice(0,3) : [];

  const total = questions.length;
  const currentQ = phase==="review" ? wrongQueue[reviewIdx] : questions[qIdx];
  const q = currentQ;
  // Shuffle the English column of a "match" question so the answer isn't sitting
  // directly across from its French word. Stable within a question, reshuffles per question.
  const matchEnOrder = useMemo(
    ()=> (q && q.type==="match") ? [...(q.pairs||[]).keys()].sort(()=>Math.random()-0.5) : [],
    [q]
  );
  const isOk = q && (() => {
    if(!q) return false;
    if(q.type==="match") return matchDone.length === (q.pairs||[]).length && matchWrong.length===0;
    if(q.type==="tap"||q.type==="mcq"||q.type==="scene"||q.type==="listen"||q.type==="read") return selected===q.correct;
    if(q.type==="fill") return selected===q.correct;
    if(q.type==="order") return JSON.stringify(orderPlaced)===JSON.stringify(q.answer);
    return false; // write & speak grade via their own AI components — never auto-pass
  })();

  const speak=(text)=>{
    if(!text) return;
    stopFrench();
    const u=new SpeechSynthesisUtterance(text);
    u.lang="en-CA"; u.rate=0.9;
    window.speechSynthesis?.speak(u);
  };

  const resetQ=()=>{
    setSelected(null); setAnswered(false);
    setMatchSel(null); setMatchDone([]); setMatchWrong([]);
    setOrderPlaced([]); setSpeakResult(null);
    if(q?.type==="order") setOrderBank([...(q.words||[])].sort(()=>Math.random()-0.5));
  };

  const checkAnswer=()=>{
    if(answered) return;
    setAnswered(true);
    const ok = isOk;
    if(ok){
      setCorrect(x=>x+1);
      setXp(x=>x+(q.diff||1)*10);
      celebrateCorrect(); // sound + haptic only — no spoken praise
    } else {
      commiserateWrong();
      // Add to wrong queue for review at end (with different type)
      setWrongQueue(prev=>[...prev, {...q, _review:true}]);
    }
  };

  const nextQ=()=>{
    stopFrench();
    if(phase==="review"){
      if(reviewIdx<wrongQueue.length-1){ setReviewIdx(i=>i+1); resetQ(); }
      else setPhase("done");
      return;
    }
    if(qIdx<total-1){ setQIdx(i=>i+1); resetQ(); }
    else {
      if(wrongQueue.length>0){ setPhase("review"); setReviewIdx(0); resetQ(); }
      else {
        setPhase("done");
        setShowConfetti(true);
        celebrateLevelUp();
        setTimeout(()=>setShowConfetti(false),4000);
      }
    }
  };

  const handleTeachDone=()=>{ setPhase("questions"); resetQ(); };

  // Match logic
  const handleMatch=(side,idx)=>{
    if(answered) return;
    const sel=matchSel;
    if(!sel){ setMatchSel({side,idx}); return; }
    if(sel.side===side){ setMatchSel({side,idx}); return; }
    const frIdx=side==="en"?sel.idx:idx;
    const enIdx=side==="en"?idx:sel.idx;
    const pairs=q.pairs||[];
    const isMatch=pairs[frIdx]&&pairs[frIdx][1]===pairs[enIdx][1]||
      (pairs[frIdx]&&pairs[enIdx]&&pairs[frIdx][0]===pairs[enIdx][0]);
    // Check if fr[frIdx] matches en[enIdx]
    const frWord=pairs[frIdx]?.[0];
    const enWord=pairs[enIdx]?.[1]||pairs[enIdx]?.[0];
    const matched=pairs.find(p=>p[0]===frWord&&p[1]===enWord);
    if(matched){
      setMatchDone(d=>[...d,frWord]);
      setMatchSel(null);
      if(matchDone.length+1===pairs.length){ setAnswered(true); setCorrect(x=>x+1); }
    } else {
      setMatchWrong(w=>[...w,frWord]);
      setMatchSel(null);
      setTimeout(()=>setMatchWrong(w=>w.filter(x=>x!==frWord)),800);
    }
  };

  useEffect(()=>{
    if(q?.type==="order"&&!answered) setOrderBank([...(q.words||[])].sort(()=>Math.random()-0.5));
  },[qIdx,phase,reviewIdx]);

  // Stop any French audio when the lesson unmounts — e.g. if the learner taps a
  // nav tab instead of the ✕ exit (the tabs are now visible during a lesson).
  useEffect(()=>()=>stopFrench(),[]);

  // Stop any in-progress audio whenever the learner moves to a different slide,
  // question, or phase — so a "Listen" clip never keeps playing on the next page.
  useEffect(()=>{ stopFrench(); }, [teachSlide, qIdx, reviewIdx, phase]);

  // Save progress the moment the lesson reaches its results — so it's never lost,
  // however the learner leaves the results screen (button, ✕, or a nav tab).
  useEffect(()=>{
    if(phase==="done"){
      onDone?.(lesson.id, Math.max(0,Math.min(5,Math.round((correct/Math.max(total,1))*5))));
      clearLessonProg(lesson.id); // lesson finished — clear the resume checkpoint
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[phase]);

  // Continuously checkpoint mid-lesson position + score so leaving / going back
  // (or the app closing) resumes here next time. Graded lessons only.
  useEffect(()=>{
    if(lesson.practice) return;
    if(phase==="questions" && qIdx>0){
      writeLessonProg(lesson.id, {qIdx, correct, xp, t:Date.now()});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[phase, qIdx, correct, xp]);

  // Persist missed questions to a local review pool — powers "Review your mistakes" (works offline / in guest mode)
  useEffect(()=>{
    if(phase!=="done"||lesson.practice) return;
    try{
      const prev=JSON.parse(localStorage.getItem("franco_review_pool")||"[]");
      const key=(x)=>x.prompt||x.fr||x.before||x.audio||x.passage||JSON.stringify(x).slice(0,60);
      const seen=new Set(prev.map(key));
      const adds=wrongQueue.filter(x=>x&&!seen.has(key(x))).map(({_review,...rest})=>rest);
      if(adds.length) localStorage.setItem("franco_review_pool",JSON.stringify([...adds,...prev].slice(0,50)));
    }catch{}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[phase]);

  const diffColor=(d)=>d<=1?"#10B981":d<=2?"#3B82F6":d<=3?"#F59E0B":d<=4?"#EF4444":"#8B5CF6";
  const diffLabel=(d)=>d<=1?"Easy ⭐":d<=2?"Medium ⭐⭐":d<=3?"Hard ⭐⭐⭐":d<=4?"Very Hard":"Expert";

  // ── Recap Phase ──
  if(phase==="recap"){
    if(recapQs.length===0||recapDone){
      setPhase("teach"); setRecapDone(true);
      return null;
    }
    return <div style={{minHeight:"100vh",background:"#F8FAFC"}}>
      <div style={{background:"#fff",borderBottom:"1px solid #E2E8F0",position:"relative",zIndex:1}}>
        <div style={{padding:"0 16px",height:46,display:"flex",alignItems:"center",gap:10}}>
          <button onClick={()=>{stopFrench();onBack();}} style={{background:"none",border:"none",padding:"4px",fontSize:13,fontWeight:600,cursor:"pointer",color:"#64748B"}}>← Back</button>
          <div style={{flex:1,fontSize:12,fontWeight:700,color:"#0F172A"}}>Quick Recap</div>
          <div style={{fontSize:11,color:"#94A3B8"}}>Before we start</div>
        </div>
        <div style={{height:2,background:"#F1F5F9"}}><div style={{height:"100%",width:"15%",background:"#F59E0B"}}/></div>
      </div>
      <div style={{padding:"20px 16px",maxWidth:640,margin:"0 auto"}}>
        <div style={{background:"#FFFBEB",borderRadius:14,padding:"14px 16px",display:"flex",alignItems:"center",gap:12,marginBottom:16,border:"1px solid #FCD34D"}}>
          <span style={{fontSize:24}}>⚡</span>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:"#92400E"}}>Quick recap from last lesson!</div>
            <div style={{fontSize:12,color:"#78350F"}}>{recapQs.length} quick questions — then we start the new lesson</div>
          </div>
        </div>
        <div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",padding:"20px",textAlign:"center"}}>
          <div style={{fontSize:32,marginBottom:12}}>🧠</div>
          <div style={{fontSize:15,fontWeight:700,color:"#0F172A",marginBottom:8}}>Remember this?</div>
          <div style={{fontSize:13,color:"#64748B",marginBottom:20}}>These words came from your last lesson. Let's make sure they stick!</div>
          <button onClick={()=>{setRecapDone(true);setPhase("teach");}}
            style={{background:"#F59E0B",color:"#fff",border:"none",padding:"12px 28px",borderRadius:12,fontFamily:"system-ui",fontWeight:800,fontSize:14,cursor:"pointer"}}>
            Start Recap ⚡
          </button>
          <div style={{marginTop:10}}><button onClick={()=>{setRecapDone(true);setPhase("teach");}} style={{background:"none",border:"none",color:"#94A3B8",fontSize:12,cursor:"pointer"}}>Skip recap →</button></div>
        </div>
      </div>
    </div>;
  }

  return <div style={{minHeight:"100vh",background:"#F8FAFC"}}>
    {/* TOP BAR */}
    {(()=>{
      const inQ = phase==="questions"||phase==="review";
      const segTotal = phase==="review" ? Math.max(wrongQueue.length,1) : total;
      const segCur = phase==="review" ? reviewIdx : qIdx;
      const accent = phase==="review" ? "#F59E0B" : "#10B981";
      return <div style={{background:"#fff",borderBottom:"1px solid #E2E8F0",position:"relative",zIndex:1}}>
        <div style={{padding:"9px 14px 8px",display:"flex",alignItems:"center",gap:12}}>
          {/* Exit (confirms only mid-lesson) */}
          <button onClick={()=>{ if(phase==="done"||window.confirm("Leave this lesson? Your spot is saved — you can pick up where you left off.")){ stopFrench(); onBack(); } }}
            aria-label="Close lesson"
            style={{background:"#F1F5F9",border:"none",width:30,height:30,borderRadius:"50%",fontSize:15,fontWeight:700,cursor:"pointer",color:"#64748B",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>✕</button>
          {/* Progress — segmented per question (Duolingo-style) when in questions/review */}
          {inQ
            ? <div style={{flex:1,display:"flex",gap:4,alignItems:"center"}}>
                {Array.from({length:Math.min(segTotal,14)}).map((_,i)=>{
                  const filled = i<segCur || (i===segCur && answered && isOk);
                  const current = i===segCur;
                  return <div key={i} style={{flex:1,height:9,borderRadius:99,background:filled?accent:current?"#0F172A":"#E2E8F0",boxShadow:current&&!filled?"0 0 0 2px #0F172A22":"none",transition:"all 0.3s"}}/>;
                })}
              </div>
            : <div style={{flex:1,height:9,background:"#F1F5F9",borderRadius:99,overflow:"hidden"}}><div style={{height:"100%",width:phase==="teach"?"10%":"100%",background:"#10B981",borderRadius:99,transition:"width 0.4s"}}/></div>}
          <div style={{fontSize:12,fontWeight:800,color:"#0F172A",flexShrink:0,minWidth:40,textAlign:"right",fontVariantNumeric:"tabular-nums"}}>
            {phase==="teach"?"Intro":phase==="done"?"🎉":`${segCur+1}/${segTotal}`}
          </div>
        </div>
        <div style={{padding:"0 16px 8px",fontSize:11,fontWeight:600,color:"#94A3B8",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
          {phase==="review"?"🔄 Review — these come back so they stick":lesson.title}
        </div>
      </div>;
    })()}

    <div style={{padding:"14px 16px 80px",maxWidth:640,margin:"0 auto",display:"flex",flexDirection:"column",gap:14}}>

      {/* ══ TEACH PHASE ══ */}
      {phase==="teach"&&(()=>{
        const slides=[{type:"intro",cta:"Let's learn →"},{type:"vocab",cta:"Got it →"},{type:"ready",cta:"Start questions →"}];
        const slide=slides[teachSlide];
        const companionMsgs=[
          `Bonjour! I'm ${c.name}. Today: "${lesson.title}". This lesson is based on real situations you'll face in Canada — read carefully! 😊`,
          `Great! These are the key words. Tap each one to see the meaning. Tap 🔈 to hear the pronunciation!`,
          `You're ready! Questions start easy and get harder. Wrong answers come back at the end in a different format — that's how your brain learns! 💪`
        ];
        const next=()=>teachSlide===slides.length-1?handleTeachDone():setTeachSlide(s=>s+1);
        return <>
          <div style={{display:"flex",gap:6,justifyContent:"center"}}>
            {slides.map((_,i)=><div key={i} style={{width:i===teachSlide?24:6,height:6,borderRadius:99,background:i===teachSlide?"#0F172A":i<teachSlide?"#94A3B8":"#E2E8F0",transition:"all 0.3s"}}/>)}
          </div>
          <div style={{background:"#0F172A",borderRadius:14,padding:"12px 14px",display:"flex",alignItems:"center",gap:10}}>
            <Avatar companion={c} size={34}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:10,color:"rgba(255,255,255,0.4)",fontWeight:700,textTransform:"uppercase",letterSpacing:.5,marginBottom:2}}>{c.name} says</div>
              <div style={{fontSize:12,color:"rgba(255,255,255,0.9)",lineHeight:1.5,fontStyle:"italic"}}>{companionMsgs[teachSlide]}</div>
            </div>
          </div>
          <div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
            {slide.type==="intro"&&<>
              <div style={{background:"#0F172A",padding:"18px"}}>
                <div style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>{level?.cefrTag||"Pre-A1"} · {lesson.skill} · {lesson.mins} min</div>
                <div style={{fontFamily:"Georgia,serif",fontSize:20,fontWeight:800,color:"#fff",lineHeight:1.25}}>{lesson.title}</div>
              </div>
              <div style={{background:"#FFFBEB",borderBottom:"1px solid #FDE68A",padding:"12px 16px",display:"flex",gap:10,alignItems:"flex-start"}}>
                <div style={{fontSize:20,lineHeight:1}}>📓</div>
                <div style={{fontSize:12.5,color:"#92400E",lineHeight:1.6}}>
                  <b>Before you start:</b> watch today's video with Sophie and keep your notebook beside you. Write down the key words as she teaches them — <b>then</b> answer the questions to lock it all in. ✍️
                </div>
              </div>
              {(()=>{
                // Video embed appears ONLY when a HeyGen URL is set in
                // src/lessonVideos.js. If no URL, render nothing (no "coming
                // soon" badge — the lesson is fully usable via text + Sophie).
                const v = getLessonVideo(lesson.id);
                const embed = youTubeEmbedUrl(v?.url);
                if (!embed) return null;
                return <div style={{position:"relative",width:"100%",paddingBottom:"56.25%",background:"#000"}}>
                  <iframe
                    src={embed}
                    title={lesson.title}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",border:0}}
                  />
                </div>;
              })()}
              <div style={{padding:"16px 18px"}}>
                <div style={{fontSize:10,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:.8,marginBottom:10}}>The story</div>
                <div style={{fontSize:14,color:"#334155",lineHeight:1.85,marginBottom:14}}>{lesson.teach}</div>
                {HEYGEN_ENABLED && <button onClick={()=>setShowCall(true)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"linear-gradient(135deg,#7C3AED,#2563EB)",border:"none",borderRadius:12,padding:"13px 16px",fontSize:14,color:"#fff",cursor:"pointer",fontWeight:800,marginBottom:12}}>📹 Learn this lesson live with Sophie</button>}
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <button onClick={()=>speakFrench(lesson.teach)} style={{display:"flex",alignItems:"center",gap:6,background:"#F8FAFC",border:"1px solid #E2E8F0",borderRadius:50,padding:"6px 14px",fontSize:12,color:"#64748B",cursor:"pointer",fontWeight:600}}>🔈 Listen</button>
                  {onPracticeWithSophie && <button onClick={()=>onPracticeWithSophie(lesson)} style={{display:"flex",alignItems:"center",gap:6,background:"#EFF6FF",border:"1px solid #BFDBFE",borderRadius:50,padding:"6px 14px",fontSize:12,color:"#1E40AF",cursor:"pointer",fontWeight:700}}>🎓 Practice with Sophie</button>}
                </div>
              </div>
            </>}
            {slide.type==="vocab"&&<>
              <div style={{padding:"16px 18px 10px",borderBottom:"1px solid #F1F5F9"}}>
                <div style={{fontFamily:"Georgia,serif",fontSize:17,fontWeight:800,color:"#0F172A",marginBottom:3}}>Key vocabulary</div>
                <div style={{fontSize:11,color:"#94A3B8"}}>Tap to translate · 🔈 to hear pronunciation</div>
              </div>
              <div style={{padding:"14px 18px"}}><VocabFlipList vocab={lesson.vocab}/></div>
              <div style={{padding:"10px 18px",background:"#F8FAFC",borderTop:"1px solid #F1F5F9",fontSize:11,color:"#64748B"}}>💡 These words appear in the questions — learn them well!</div>
            </>}
            {slide.type==="ready"&&<div style={{padding:"28px 20px",display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",gap:14}}>
              <div style={{fontSize:48}}>🎯</div>
              <div>
                <div style={{fontFamily:"Georgia,serif",fontSize:19,fontWeight:800,color:"#0F172A",marginBottom:6}}>Ready to practise?</div>
                <div style={{fontSize:13,color:"#64748B",lineHeight:1.6}}>{total} questions · easy first · wrong answers reviewed at end</div>
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"center"}}>
                {[...new Set((lesson.questions||[]).map(q=>q.type))].map(t=>{
                  const icons={tap:"👆 Tap",mcq:"🎯 Choose",fill:"✏️ Fill",order:"🔀 Build",write:"✍️ Write",speak:"🎤 Speak",match:"🔗 Match",scene:"📖 Story"};
                  return <span key={t} style={{fontSize:12,fontWeight:600,padding:"5px 12px",borderRadius:50,background:"#F1F5F9",color:"#475569"}}>{icons[t]||t}</span>;
                })}
              </div>
              {wrongQueue.length===0&&<div style={{fontSize:11,color:"#94A3B8"}}>🔄 Wrong answers come back at the end in a new format</div>}
            </div>}
          </div>
          <div style={{display:"flex",gap:8}}>
            {teachSlide>0&&<button onClick={()=>setTeachSlide(s=>s-1)} style={{padding:"13px 18px",background:"#F8FAFC",color:"#64748B",border:"1px solid #E2E8F0",borderRadius:12,fontFamily:"system-ui",fontWeight:600,fontSize:13,cursor:"pointer"}}>← Back</button>}
            <button onClick={next} style={{flex:1,padding:"14px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontFamily:"system-ui",fontWeight:800,fontSize:14,cursor:"pointer"}}>{slide.cta}</button>
          </div>
        </>;
      })()}

      {/* ══ QUESTION / REVIEW PHASE ══ */}
      {(phase==="questions"||phase==="review")&&q&&<>
        {/* Review banner */}
        {phase==="review"&&<div style={{background:"#FEF3C7",borderRadius:12,padding:"10px 14px",display:"flex",gap:10,alignItems:"center",border:"1px solid #FCD34D"}}>
          <span style={{fontSize:20}}>🔄</span>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"#92400E"}}>Review time! Different question, same word.</div>
            <div style={{fontSize:11,color:"#78350F"}}>Question {reviewIdx+1} of {wrongQueue.length} — your brain learns better this way!</div>
          </div>
        </div>}

        {/* Question type label — colored skill chip (skip for the mini-game) */}
        {q.type!=="minigame"&&(()=>{
          const tm={
            tap:{l:"👆 Tap the answer",c:"#2563EB",bg:"#EFF6FF"},
            mcq:{l:"🎯 Choose the best answer",c:"#2563EB",bg:"#EFF6FF"},
            fill:{l:"✏️ Fill in the blank",c:"#059669",bg:"#ECFDF5"},
            order:{l:"🔀 Build the sentence",c:"#059669",bg:"#ECFDF5"},
            match:{l:"🔗 Match the pairs",c:"#DC2626",bg:"#FEF2F2"},
            scene:{l:"📖 Read & answer",c:"#D97706",bg:"#FFFBEB"},
            listen:{l:"🎧 Listen & answer",c:"#7C3AED",bg:"#F5F3FF"},
            read:{l:"📰 Read the passage",c:"#D97706",bg:"#FFFBEB"},
            speak:{l:"🎤 Your turn to speak",c:"#EA580C",bg:"#FFF7ED"},
            write:{l:"✍️ Write it out",c:"#2563EB",bg:"#EFF6FF"},
          }[q.type]||{l:"✍️ Write it out",c:"#2563EB",bg:"#EFF6FF"};
          return <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <span style={{fontSize:11.5,fontWeight:800,color:tm.c,background:tm.bg,borderRadius:50,padding:"5px 13px"}}>{tm.l}</span>
            <div style={{flex:1,minWidth:8}}/>
            <span style={{fontSize:10,fontWeight:700,color:diffColor(q.diff||2),background:diffColor(q.diff||2)+"18",borderRadius:50,padding:"4px 11px"}}>{diffLabel(q.diff||2)}</span>
          </div>;
        })()}

        {/* Ask Sophie for a hint on this question (resets per question) */}
        {!answered&&q.type!=="speak"&&q.type!=="minigame"&&<DoubtButton key={phase==="review"?"r"+reviewIdx:"q"+qIdx} q={q}/>}

        {/* TAP */}
        {q.type==="tap"&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
          <div style={{padding:"24px 20px 16px",textAlign:"center",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{fontFamily:"Georgia,serif",fontSize:34,fontWeight:800,color:"#0F172A",marginBottom:8}}>{q.fr}</div>
            <div style={{fontSize:12,color:"#94A3B8",marginBottom:12}}>What does this mean in English?</div>
            <button onClick={()=>speakFrench(q.fr)} style={{background:"#F8FAFC",border:"1px solid #E2E8F0",borderRadius:50,padding:"5px 14px",fontSize:12,color:"#64748B",cursor:"pointer"}}>🔈 Listen</button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr"}}>
            {q.opts.map((opt,i)=>{const isSel=selected===i,isC=answered&&i===q.correct,isW=answered&&isSel&&i!==q.correct;
              return <button key={i} disabled={answered} onClick={()=>setSelected(i)}
                style={{padding:"16px 12px",border:"none",borderRight:i%2===0?"1px solid #F1F5F9":"none",borderTop:"1px solid #F1F5F9",background:isC?"#ECFDF5":isW?"#FEF2F2":isSel?"#EFF6FF":"#fff",cursor:answered?"default":"pointer",fontSize:14,fontWeight:600,color:isC?"#059669":isW?"#DC2626":isSel?"#2563EB":"#0F172A",transition:"all 0.15s"}}>
                {isC?"✓ ":isW?"✗ ":""}{opt}</button>;
            })}
          </div>
        </div>}

        {/* MCQ & SCENE */}
        {(q.type==="mcq"||q.type==="scene")&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
          {q.type==="scene"&&q.story&&<div style={{padding:"14px 18px",background:"#F8FAFC",borderBottom:"1px solid #F1F5F9",fontSize:13,color:"#334155",lineHeight:1.7,fontStyle:"italic",borderLeft:"3px solid #3B82F6"}}>
            📖 {q.story}
          </div>}
          <div style={{padding:"16px 18px",borderBottom:"1px solid #F1F5F9",display:"flex",gap:10}}>
            <div style={{flex:1,fontSize:15,fontWeight:700,color:"#0F172A",lineHeight:1.55}}>{q.prompt}</div>
            <button onClick={()=>speakFrench(q.prompt)} style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:"#94A3B8",padding:0}}>🔈</button>
          </div>
          <div style={{display:"flex",flexDirection:"column"}}>
            {(q.options||[]).map((opt,i)=>{const isSel=selected===i,isC=answered&&i===q.correct,isW=answered&&isSel&&i!==q.correct;
              return <button key={i} disabled={answered} onClick={()=>setSelected(i)}
                style={{padding:"13px 18px",border:"none",borderTop:"1px solid #F1F5F9",background:isC?"#ECFDF5":isW?"#FEF2F2":isSel?"#EFF6FF":"#fff",cursor:answered?"default":"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:12,fontSize:14,color:isC?"#059669":isW?"#DC2626":isSel?"#2563EB":"#0F172A",fontWeight:isSel||isC||isW?600:400,transition:"all 0.15s"}}>
                <span style={{width:24,height:24,borderRadius:6,background:isC?"#059669":isW?"#DC2626":isSel?"#2563EB":"#F1F5F9",color:isC||isW||isSel?"#fff":"#64748B",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:11,flexShrink:0}}>{["A","B","C","D"][i]}</span>{opt}
              </button>;
            })}
          </div>
        </div>}

        {/* LISTEN — plays French audio via on-device TTS, then a comprehension MCQ */}
        {q.type==="listen"&&<ListenQuestion key={`${phase}-${qIdx}-${reviewIdx}`} q={q} selected={selected} setSelected={setSelected} answered={answered}/>}

        {/* READ — shows a real French passage, then a comprehension MCQ */}
        {q.type==="read"&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
          {q.title&&<div style={{padding:"14px 18px 0",fontFamily:"Georgia,serif",fontSize:16,fontWeight:800,color:"#0F172A"}}>{q.title}</div>}
          <div style={{padding:"14px 18px",background:"#FBFAF7",borderBottom:"1px solid #F1F5F9",borderLeft:"3px solid #D97706",fontSize:14,color:"#1F2937",lineHeight:1.85,maxHeight:280,overflowY:"auto",whiteSpace:"pre-wrap"}}>{q.passage}</div>
          {Array.isArray(q.glossary)&&q.glossary.length>0&&<div style={{padding:"10px 18px",display:"flex",flexWrap:"wrap",gap:6,borderBottom:"1px solid #F1F5F9",background:"#FEFCE8"}}>
            {q.glossary.map((g,i)=><span key={i} style={{fontSize:11,color:"#854D0E",background:"#FEF9C3",border:"1px solid #FDE68A",borderRadius:50,padding:"3px 9px"}}><b>{g[0]}</b> — {g[1]}</span>)}
          </div>}
          <div style={{padding:"16px 18px",borderBottom:"1px solid #F1F5F9",fontSize:15,fontWeight:700,color:"#0F172A",lineHeight:1.55}}>{q.prompt}</div>
          <div style={{display:"flex",flexDirection:"column"}}>
            {(q.options||[]).map((opt,i)=>{const isSel=selected===i,isC=answered&&i===q.correct,isW=answered&&isSel&&i!==q.correct;
              return <button key={i} disabled={answered} onClick={()=>setSelected(i)}
                style={{padding:"13px 18px",border:"none",borderTop:"1px solid #F1F5F9",background:isC?"#ECFDF5":isW?"#FEF2F2":isSel?"#EFF6FF":"#fff",cursor:answered?"default":"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:12,fontSize:14,color:isC?"#059669":isW?"#DC2626":isSel?"#2563EB":"#0F172A",fontWeight:isSel||isC||isW?600:400,transition:"all 0.15s"}}>
                <span style={{width:24,height:24,borderRadius:6,background:isC?"#059669":isW?"#DC2626":isSel?"#2563EB":"#F1F5F9",color:isC||isW||isSel?"#fff":"#64748B",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:11,flexShrink:0}}>{["A","B","C","D"][i]}</span>{opt}
              </button>;
            })}
          </div>
        </div>}

        {/* FILL */}
        {q.type==="fill"&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
          <div style={{padding:"18px",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{fontSize:18,fontWeight:700,color:"#0F172A",lineHeight:1.7}}>
              {q.before} <span style={{display:"inline-block",minWidth:70,borderBottom:`2px solid ${answered?(isOk?"#059669":"#DC2626"):"#2563EB"}`,padding:"2px 6px",color:answered?isOk?"#059669":"#DC2626":"#2563EB",fontStyle:"italic"}}>{selected!==null?(q.options||[])[selected]:"___"}</span> {q.after}
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr"}}>
            {(q.options||[]).map((opt,i)=>{const isSel=selected===i,isC=answered&&i===q.correct,isW=answered&&isSel&&i!==q.correct;
              return <button key={i} disabled={answered} onClick={()=>setSelected(i)}
                style={{padding:"13px 12px",border:"none",borderRight:i%2===0?"1px solid #F1F5F9":"none",borderTop:"1px solid #F1F5F9",background:isC?"#ECFDF5":isW?"#FEF2F2":isSel?"#EFF6FF":"#fff",cursor:answered?"default":"pointer",fontSize:14,fontWeight:600,color:isC?"#059669":isW?"#DC2626":isSel?"#2563EB":"#0F172A"}}>{isC?"✓ ":isW?"✗ ":""}{opt}</button>;
            })}
          </div>
        </div>}

        {/* MATCH */}
        {q.type==="match"&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
          <div style={{padding:"14px 18px",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{fontSize:14,fontWeight:700,color:"#0F172A",marginBottom:4}}>{q.prompt}</div>
            <div style={{fontSize:11,color:"#94A3B8"}}>Tap a French word, then tap its English meaning</div>
          </div>
          <div style={{padding:"14px 18px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              <div style={{fontSize:10,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:.5,marginBottom:2}}>French</div>
              {(q.pairs||[]).map((pair,i)=>{
                const isDone=matchDone.includes(pair[0]);
                const isSel=matchSel?.side==="fr"&&matchSel?.idx===i;
                const isWrong=matchWrong.includes(pair[0]);
                return <div key={i} style={{display:"flex",alignItems:"center",gap:4}}>
                  <button disabled={isDone} onClick={()=>handleMatch("fr",i)}
                    style={{flex:1,minWidth:0,padding:"10px 12px",borderRadius:10,border:`2px solid ${isDone?"#10B981":isWrong?"#EF4444":isSel?"#2563EB":"#E2E8F0"}`,background:isDone?"#ECFDF5":isWrong?"#FEF2F2":isSel?"#EFF6FF":"#F8FAFC",fontSize:13,fontWeight:600,color:isDone?"#059669":isWrong?"#DC2626":isSel?"#2563EB":"#0F172A",cursor:isDone?"default":"pointer",textAlign:"left",transition:"all 0.2s",textDecoration:isDone?"line-through":"none"}}>
                    {pair[0]}
                  </button>
                  <SpeakBtn text={pair[0]} size={13}/>
                </div>;
              })}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              <div style={{fontSize:10,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:.5,marginBottom:2}}>English</div>
              {matchEnOrder.map((origIdx)=>{
                const pair=(q.pairs||[])[origIdx]; if(!pair) return null;
                const isDone=matchDone.includes(pair[0]);
                const isSel=matchSel?.side==="en"&&matchSel?.idx===origIdx;
                return <button key={origIdx} disabled={isDone} onClick={()=>handleMatch("en",origIdx)}
                  style={{padding:"10px 12px",borderRadius:10,border:`2px solid ${isDone?"#10B981":isSel?"#2563EB":"#E2E8F0"}`,background:isDone?"#ECFDF5":isSel?"#EFF6FF":"#F8FAFC",fontSize:13,fontWeight:500,color:isDone?"#059669":isSel?"#2563EB":"#475569",cursor:isDone?"default":"pointer",textAlign:"left",transition:"all 0.2s"}}>
                  {pair[1]}
                </button>;
              })}
            </div>
          </div>
          {matchDone.length===(q.pairs||[]).length&&<div style={{padding:"10px 18px",background:"#ECFDF5",borderTop:"1px solid #D1FAE5",fontSize:13,fontWeight:700,color:"#059669",textAlign:"center"}}>
            ✓ All matched! {q.explain}
          </div>}
        </div>}

        {/* ORDER */}
        {q.type==="order"&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
          <div style={{padding:"14px 18px",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{fontSize:13,color:"#94A3B8",marginBottom:10}}>Tap words to build the sentence</div>
            <div style={{minHeight:48,padding:"10px 12px",background:"#F8FAFC",borderRadius:10,border:`1.5px dashed ${answered?(isOk?"#059669":"#DC2626"):"#CBD5E0"}`,display:"flex",flexWrap:"wrap",gap:6,alignItems:"center"}}>
              {orderPlaced.length===0&&<span style={{color:"#CBD5E0",fontSize:13}}>Tap words below...</span>}
              {orderPlaced.map((w,i)=><button key={i} disabled={answered} onClick={()=>{if(answered)return;const word=orderPlaced[i];setOrderPlaced(p=>{const n=[...p];n.splice(i,1);return n;});setOrderBank(b=>[...b,word]);}}
                style={{padding:"6px 12px",borderRadius:50,background:answered?isOk?"#059669":"#DC2626":"#0F172A",color:"#fff",border:"none",fontWeight:600,fontSize:13,cursor:answered?"default":"pointer"}}>{w}</button>)}
            </div>
          </div>
          <div style={{padding:"12px 18px",display:"flex",flexWrap:"wrap",gap:8}}>
            {orderBank.map((w,i)=><button key={i} disabled={answered} onClick={()=>{setOrderPlaced(p=>[...p,w]);setOrderBank(b=>{const n=[...b];n.splice(i,1);return n;});}}
              style={{padding:"6px 12px",borderRadius:50,background:"#F8FAFC",border:"1.5px solid #E2E8F0",fontWeight:600,fontSize:13,cursor:"pointer",color:"#0F172A"}}>{w}</button>)}
          </div>
        </div>}

        {/* WRITE */}
        {q.type==="write"&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
          <div style={{padding:"18px",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{fontSize:15,fontWeight:700,color:"#0F172A",lineHeight:1.55}}>{q.prompt}</div>
            {q.hint&&<div style={{fontSize:12,color:"#92400E",background:"#FFFBEB",padding:"8px 12px",borderRadius:8,border:"1px solid #FCD34D",marginTop:8}}>💡 {q.hint}</div>}
          </div>
          <div style={{padding:"14px 18px"}}>
            <div style={{fontSize:11,color:"#94A3B8",marginBottom:8}}>Write in French — Sophie will check it</div>
            <AIWritingChecker key={`${phase}-${qIdx}-${reviewIdx}`} prompt={q.prompt} accepted={q.accepted} level={level?.cefrTag||"A1"}
              onResult={(ok)=>{if(!answered){setAnswered(true);if(ok){setCorrect(x=>x+1);setXp(x=>x+(q.diff||1)*10);celebrateCorrect();}else{commiserateWrong();setWrongQueue(prev=>[...prev,{...q,_review:true}]);}}}}/>
          </div>
        </div>}

        {/* SPEAK */}
        {q.type==="speak"&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
          <div style={{padding:"18px",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{fontSize:15,fontWeight:700,color:"#0F172A",lineHeight:1.55}}>{q.prompt}</div>
          </div>
          <div style={{padding:"14px 18px"}}>
            <AISpeakingCoach key={`${phase}-${qIdx}-${reviewIdx}`} prompt={q.prompt} sampleAnswer={q.sampleAnswer||q.accepted?.[0]||""}
              onDone={(passed)=>{if(!answered){setAnswered(true);if(passed){setCorrect(x=>x+1);setXp(x=>x+(q.diff||1)*10);}}}}/>
          </div>
        </div>}

        {/* MINI-GAME — self-contained Word Rush; handles its own scoring + advance */}
        {q.type==="minigame"&&<MiniGameQuestion key={`g-${qIdx}`} pairs={q.pairs}
          onComplete={(gscore)=>{ setCorrect(x=>x+1); setXp(x=>x+10+(gscore||0)*5); nextQ(); }}/>}

        {/* FEEDBACK — write & speak show their own AI result, so skip them here */}
        {answered&&q.type!=="match"&&q.type!=="write"&&q.type!=="speak"&&q.type!=="minigame"&&<div style={{borderRadius:14,border:`1px solid ${isOk?"#6EE7B7":"#FCA5A5"}`,background:isOk?"#F0FDF4":"#FFF5F5",padding:"14px 16px",display:"flex",gap:12}}>
          <span style={{fontSize:20,flexShrink:0}}>{isOk?"✅":"💡"}</span>
          <div>
            <div style={{fontWeight:700,fontSize:13,color:isOk?"#059669":"#DC2626",marginBottom:4}}>
              {isOk?"Correct!":"Good try — here's why:"}
            </div>
            <div style={{fontSize:13,color:isOk?"#065F46":"#7F1D1D",lineHeight:1.65}}>{q.explain}</div>
            {!isOk&&phase!=="review"&&<div style={{marginTop:6,fontSize:11,color:"#94A3B8"}}>🔄 This will come back at the end in a different format</div>}
          </div>
        </div>}

        {/* ACTIONS — hidden for the mini-game, which advances itself */}
        {q.type!=="minigame"&&<div style={{display:"flex",gap:8,alignItems:"center"}}>
          {q.type==="match"?
            <button onClick={()=>nextQ()} disabled={matchDone.length!==(q.pairs||[]).length}
              style={{flex:1,padding:"13px",background:matchDone.length===(q.pairs||[]).length?"#0F172A":"#F1F5F9",color:matchDone.length===(q.pairs||[]).length?"#fff":"#94A3B8",border:"none",borderRadius:12,fontFamily:"system-ui",fontWeight:700,fontSize:14,cursor:"pointer"}}>
              {qIdx<total-1?"Next →":"See Results →"}
            </button>
          :(q.type==="write"||q.type==="speak")?
            (answered?<button onClick={nextQ} style={{flex:1,padding:"13px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontFamily:"system-ui",fontWeight:700,fontSize:14,cursor:"pointer"}}>{phase==="review"?reviewIdx<wrongQueue.length-1?"Next Review →":"See Results →":qIdx<total-1?"Next Question →":"See Results →"}</button>:null)
          :!answered?
            <button onClick={checkAnswer}
              disabled={(q.type==="tap"||q.type==="mcq"||q.type==="fill"||q.type==="scene"||q.type==="listen"||q.type==="read")?selected===null:q.type==="order"?orderPlaced.length===0:false}
              style={{flex:1,padding:"13px",background:((q.type==="tap"||q.type==="mcq"||q.type==="fill"||q.type==="scene"||q.type==="listen"||q.type==="read")&&selected===null)||(q.type==="order"&&orderPlaced.length===0)?"#F1F5F9":"#0F172A",color:((q.type==="tap"||q.type==="mcq"||q.type==="fill"||q.type==="scene"||q.type==="listen"||q.type==="read")&&selected===null)||(q.type==="order"&&orderPlaced.length===0)?"#94A3B8":"#fff",border:"none",borderRadius:12,fontFamily:"system-ui",fontWeight:700,fontSize:14,cursor:"pointer",transition:"all 0.2s"}}>
              Check Answer
            </button>
          :
            <button onClick={nextQ}
              style={{flex:1,padding:"13px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontFamily:"system-ui",fontWeight:700,fontSize:14,cursor:"pointer"}}>
              {phase==="review"?reviewIdx<wrongQueue.length-1?"Next Review →":"See Results →":qIdx<total-1?"Next Question →":"See Results →"}
            </button>
          }
          {!answered&&q.type!=="match"&&
            <button onClick={()=>nextQ()} style={{padding:"13px 16px",background:"#F8FAFC",color:"#94A3B8",border:"1px solid #E2E8F0",borderRadius:12,fontFamily:"system-ui",fontWeight:600,fontSize:13,cursor:"pointer"}}>Skip</button>}
          {!answered&&q.type!=="match"&&<AIHintButton question={q} level={level?.cefrTag||"A1"}/>}
        </div>}
      </>}

      {/* ══ DONE PHASE ══ */}
      {phase==="done"&&<div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:16,padding:"20px 0",textAlign:"center"}}>
        {showConfetti&&<div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:9999}}>
          {Array.from({length:50}).map((_,i)=>{const colors=["#059669","#D97706","#2563EB","#F472B6","#7C3AED"];const x=Math.random()*100;const delay=Math.random()*1.2;const size=5+Math.random()*7;
            return <div key={i} style={{position:"absolute",left:`${x}%`,top:"-10px",width:size,height:size,borderRadius:Math.random()>0.5?"50%":"2px",background:colors[i%colors.length],animation:`confettiFall ${1.5+Math.random()*2}s ${delay}s ease-in forwards`}}/>;
          })}</div>}
        <div style={{fontSize:64}}>{correct>=total*0.8?"🏆":correct>=total*0.6?"🎉":correct>=total*0.4?"💪":"📚"}</div>
        <div>
          <div style={{fontFamily:"Georgia,serif",fontSize:24,fontWeight:800,color:"#0F172A",marginBottom:6}}>{correct>=total*0.8?"Outstanding!":correct>=total*0.6?"Great work!":correct>=total*0.4?"Good effort!":"Keep going!"}</div>
          <div style={{fontSize:13,color:"#64748B",lineHeight:1.6,maxWidth:280}}>{correct>=total*0.8?"You're thinking in French now! 🍁":correct>=total*0.6?"Every lesson makes French easier!":"Your brain is rewiring for French. Keep going!"}</div>
        </div>
        <div style={{display:"flex",gap:10,width:"100%"}}>
          {[{val:`${correct}/${total}`,lbl:"Correct"},{val:`+${xp} XP`,lbl:"Earned"},{val:`${streak}🔥`,lbl:"Streak"}].map(s=>(
            <div key={s.lbl} style={{flex:1,background:"#fff",border:"1px solid #E2E8F0",borderRadius:12,padding:"12px 8px",textAlign:"center"}}>
              <div style={{fontSize:16,fontWeight:800,color:"#0F172A"}}>{s.val}</div>
              <div style={{fontSize:10,color:"#94A3B8",marginTop:2}}>{s.lbl}</div>
            </div>
          ))}
        </div>
        {wrongQueue.length>0&&<div style={{background:"#FEF3C7",borderRadius:12,padding:"12px 16px",width:"100%",border:"1px solid #FCD34D",textAlign:"left"}}>
          <div style={{fontSize:13,fontWeight:700,color:"#92400E",marginBottom:4}}>🔄 {wrongQueue.length} words reviewed at end</div>
          <div style={{fontSize:11,color:"#78350F"}}>These will come back in your next lesson recap — spaced repetition at work!</div>
        </div>}
        <div style={{background:"#0F172A",borderRadius:14,padding:"14px 16px",width:"100%",display:"flex",alignItems:"center",gap:12,textAlign:"left"}}>
          <span style={{fontSize:26,flexShrink:0}}>{c.emoji}</span>
          <div style={{fontSize:12,color:"rgba(255,255,255,0.85)",lineHeight:1.55,fontStyle:"italic"}}>{correct>=total*0.8?`Incroyable! French is becoming natural for you! 🇨🇦`:correct>=total*0.6?"Good work! Every lesson gets easier.":"Don't worry — every French speaker struggled at first!"}</div>
        </div>
        <div style={{width:"100%",textAlign:"left"}}>
          <div style={{fontSize:11,color:"#94A3B8",marginBottom:8,fontWeight:600}}>Words from this lesson:</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>{(lesson.vocab||[]).slice(0,8).map(v=><span key={v} style={{fontSize:12,padding:"4px 10px",borderRadius:50,background:"#F1F5F9",color:"#0F172A",fontWeight:600,fontStyle:"italic"}}>{v.split("(")[0].trim()}</span>)}</div>
        </div>
        {onPracticeWithSophie && <button onClick={()=>onPracticeWithSophie(lesson)} style={{width:"100%",padding:"13px",background:"#EFF6FF",color:"#1E40AF",border:"1.5px solid #BFDBFE",borderRadius:12,fontFamily:"system-ui",fontWeight:700,fontSize:13,cursor:"pointer"}}>🎓 Practice this lesson 1-on-1 with Sophie</button>}
        <div style={{display:"flex",gap:10,width:"100%"}}>
          <button onClick={onComplete} style={{flex:1,padding:"14px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontFamily:"system-ui",fontWeight:800,fontSize:14,cursor:"pointer"}}>✓ Complete & Continue</button>
          <button onClick={()=>{setPhase("teach");setTeachSlide(0);setQIdx(0);setCorrect(0);setXp(0);setWrongQueue([]);resetQ();}} style={{padding:"14px 18px",background:"#F8FAFC",color:"#64748B",border:"1px solid #E2E8F0",borderRadius:12,fontFamily:"system-ui",fontWeight:600,fontSize:13,cursor:"pointer"}}>↺ Try again</button>
        </div>
      </div>}

    </div>
    {showCall && <LessonVideoCall lesson={lesson} learner={{ name:(typeof localStorage!=="undefined"&&localStorage.getItem("franco_name"))||"there" }} onClose={()=>setShowCall(false)}/>}
  </div>;
}

// LISTEN question — plays French audio (on-device TTS), then a comprehension MCQ.
// Transcript stays hidden until the learner answers, so they practice the ear first.
function ListenQuestion({q, selected, setSelected, answered}){
  const[plays,setPlays]=useState(0);
  const[playing,setPlaying]=useState(false);
  const once=!!q.once; // TEF-style single listen
  const canPlay=!once||plays<1;
  const play=()=>{
    if(!canPlay&&!answered) return;
    setPlays(p=>p+1); setPlaying(true);
    // Uses the real French voice (ElevenLabs) with device-TTS fallback.
    try{ speakFrench(q.audio||""); }catch{}
    // Reset the "playing" indicator after an estimated duration (~14 chars/sec).
    const ms=Math.min(20000, Math.max(1500, String(q.audio||"").length*70));
    setTimeout(()=>setPlaying(false), ms);
  };
  return <div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
    <div style={{padding:"22px 18px",textAlign:"center",borderBottom:"1px solid #F1F5F9",background:"#F5F3FF"}}>
      <button onClick={play} disabled={!canPlay&&!answered}
        style={{background:(canPlay||answered)?"#7C3AED":"#C4B5FD",color:"#fff",border:"none",borderRadius:50,padding:"14px 26px",fontSize:15,fontWeight:700,cursor:(canPlay||answered)?"pointer":"default",display:"inline-flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:18}}>{playing?"🔊":"▶️"}</span>{plays===0?"Play audio":"Play again"}
      </button>
      <div style={{marginTop:10,fontSize:11,color:"#7C3AED",fontWeight:600}}>
        {once?(plays>=1&&!answered?"🎧 One listen only — like the real TEF":"🎧 You'll hear this once (TEF style)"):`🎧 Replay as many times as you need${plays>0?` · played ${plays}×`:""}`}
      </div>
    </div>
    <div style={{padding:"16px 18px",borderBottom:"1px solid #F1F5F9",fontSize:15,fontWeight:700,color:"#0F172A",lineHeight:1.55}}>{q.prompt}</div>
    <div style={{display:"flex",flexDirection:"column"}}>
      {(q.options||[]).map((opt,i)=>{const isSel=selected===i,isC=answered&&i===q.correct,isW=answered&&isSel&&i!==q.correct;
        return <button key={i} disabled={answered} onClick={()=>setSelected(i)}
          style={{padding:"13px 18px",border:"none",borderTop:"1px solid #F1F5F9",background:isC?"#ECFDF5":isW?"#FEF2F2":isSel?"#EFF6FF":"#fff",cursor:answered?"default":"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:12,fontSize:14,color:isC?"#059669":isW?"#DC2626":isSel?"#2563EB":"#0F172A",fontWeight:isSel||isC||isW?600:400,transition:"all 0.15s"}}>
          <span style={{width:24,height:24,borderRadius:6,background:isC?"#059669":isW?"#DC2626":isSel?"#2563EB":"#F1F5F9",color:isC||isW||isSel?"#fff":"#64748B",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:11,flexShrink:0}}>{["A","B","C","D"][i]}</span>{opt}
        </button>;
      })}
    </div>
    {/* Reveal transcript only after answering, so listening is the real task */}
    {answered&&<div style={{padding:"12px 18px",background:"#FBFAF7",borderTop:"1px solid #F1F5F9",fontSize:13,color:"#475569",lineHeight:1.7}}>
      <span style={{fontWeight:700,color:"#7C3AED"}}>Transcript:</span> {q.audio}{q.transcriptEn&&<div style={{marginTop:4,fontStyle:"italic",color:"#94A3B8"}}>{q.transcriptEn}</div>}
    </div>}
  </div>;
}

// "I have a doubt — ask Sophie": an inline, on-demand hint for the current question.
function DoubtButton({q}){
  const[open,setOpen]=useState(false);
  const[loading,setLoading]=useState(false);
  const[answer,setAnswer]=useState("");
  const ask=async()=>{
    setOpen(true);
    if(answer||loading) return;
    setLoading(true);
    const ctx=q.prompt||q.fr||q.story||q.passage||q.audio||q.before||"this question";
    const opts=(q.options||q.opts||[]).join(" / ");
    const sys="You are Sophie, a warm, expert French tutor for Canadian immigrants preparing for CLB/TEF/TCF Canada (you know those exam formats and the CLB levels well). The learner is stuck on a question and tapped 'I have a doubt'. Give a SHORT hint of 2–4 sentences: clarify the concept or nudge them toward the answer, but do NOT simply state which option is correct. Use plain English with small French examples. Never make French feel hard — normalise the confusion ('lots of people mix this up'), keep the hint small and winnable, and end on encouragement.";
    const msg=`The learner is working on: "${ctx}". Options: ${opts||"(none)"}. Give one helpful hint.`;
    try{ const r=await callClaude(sys,msg,250); setAnswer(aiError(r)!=null?"I couldn't reach Sophie just now — try re-reading the question and looking for words you already recognise. You've got this! 🌟":r); }
    catch{ setAnswer("I couldn't reach Sophie just now — try re-reading the question and looking for words you already recognise. You've got this! 🌟"); }
    setLoading(false);
  };
  return <div>
    <button onClick={ask} style={{background:"none",border:"none",color:"#7C3AED",fontSize:12,fontWeight:700,cursor:"pointer",padding:"2px 0",display:"flex",alignItems:"center",gap:6,fontFamily:"system-ui,sans-serif"}}>
      🤔 I have a doubt — ask Sophie
    </button>
    {open&&<div style={{marginTop:6,background:"#F5F3FF",border:"1px solid #DDD6FE",borderRadius:12,padding:"11px 13px",fontSize:13,color:"#4C1D95",lineHeight:1.6}}>
      {loading?<span style={{color:"#7C3AED"}}>Sophie is thinking…</span>:answer}
    </div>}
  </div>;
}

function AISpeakingCoach({prompt, sampleAnswer, onDone}){
  const[stage,setStage]=useState("ready"); // ready | recording | processing | feedback
  const[transcript,setTranscript]=useState("");
  const[feedback,setFeedback]=useState(null);
  const[mediaRec,setMediaRec]=useState(null);
  const recognitionRef=useRef(null);
  const nativeRef=useRef(null);
  const finalTextRef=useRef("");
  const doneRef=useRef(false);
  // We capture real speech two ways: Apple's native Speech framework via the
  // Capacitor plugin (reliable INSIDE the iOS app — the WebView's own speech API
  // doesn't work), and the Web Speech API (desktop browsers). If neither is
  // usable we fall back to listen-and-repeat so the task always works.
  const webSpeech = typeof window!=="undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  const canRecord = IS_IOS_APP || webSpeech;

  // Always-resolves guard: advance to analysis exactly once, so the learner can
  // never get stuck on the recording screen.
  const finish=()=>{
    if(doneRef.current) return;
    doneRef.current=true;
    setStage("processing");
    analyzeWithAI(finalTextRef.current);
  };

  const startRecording=async()=>{
    finalTextRef.current=""; doneRef.current=false; setTranscript("");
    // 1) Native iOS speech recognition (accurate, on-device via Apple's Speech framework).
    if(IS_IOS_APP){
      try{
        const mod="@capacitor-community/speech-recognition";
        const { SpeechRecognition } = await import(/* @vite-ignore */ mod);
        const perm = await SpeechRecognition.requestPermissions();
        if(perm && perm.speechRecognition==="denied") throw new Error("denied");
        try{ await SpeechRecognition.removeAllListeners(); }catch{}
        await SpeechRecognition.addListener("partialResults",(d)=>{
          const t=(d?.matches||[])[0]||""; if(t){ finalTextRef.current=t; setTranscript(t); }
        });
        await SpeechRecognition.start({ language:"fr-CA", maxResults:1, partialResults:true, popup:false });
        nativeRef.current=SpeechRecognition;
        setStage("recording");
        setTimeout(()=>stopRecording(),15000);
        return;
      }catch{ /* plugin missing / denied → try web, then self-practice */ }
    }
    // 2) Web Speech API (desktop browsers).
    if(webSpeech){
      const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
      let rec;
      try{ rec=new SR(); }catch{ finish(); return; }
      rec.lang="fr-CA"; rec.interimResults=true; rec.maxAlternatives=1;
      recognitionRef.current=rec;
      rec.onresult=(e)=>{ finalTextRef.current=Array.from(e.results).map(r=>r[0].transcript).join(" "); setTranscript(finalTextRef.current); };
      rec.onerror=()=>finish();
      rec.onend=()=>finish();
      try{ rec.start(); setStage("recording"); }catch{ finish(); return; }
      setTimeout(()=>{try{rec.stop();}catch{ finish(); }},15000);
      return;
    }
    // 3) Nothing available → resolve to self-practice feedback.
    finish();
  };

  const stopRecording=async()=>{
    if(nativeRef.current){
      try{ await nativeRef.current.stop(); }catch{}
      try{ await nativeRef.current.removeAllListeners(); }catch{}
      nativeRef.current=null;
      finish();
      return;
    }
    try{recognitionRef.current?.stop();}catch{}
    // Safety net: if onend never fires, advance anyway.
    setTimeout(finish,1500);
  };

  // Stop the mic / native recognition if the learner leaves mid-recording, so
  // listeners and the Apple Speech session don't leak after unmount.
  useEffect(()=>()=>{
    doneRef.current=true;
    try{ nativeRef.current?.stop?.(); }catch{}
    try{ nativeRef.current?.removeAllListeners?.(); }catch{}
    try{ recognitionRef.current?.stop?.(); }catch{}
  },[]);

  const analyzeWithAI=async(spokenText)=>{
    if(!spokenText.trim()){
      setFeedback({score:0,overall:"I couldn't hear anything. Please try again in a quiet place!",corrections:[],encouragement:"Don't worry — speaking a new language takes courage! Try again 💪"});
      setStage("feedback");
      return;
    }
    const sys=`You are a warm, encouraging French language coach for Canadian learners. 
Analyze the student's spoken French response and give brief, kind feedback.
Respond in JSON format exactly like this:
{
  "score": 85,
  "overall": "Really good effort! Your pronunciation was clear.",
  "corrections": ["Say 'bonjour' not 'bonzhour'", "Remember the silent 't' in 'est'"],
  "encouragement": "You're making great progress! Keep practicing!",
  "phonetic_tips": ["The French 'r' is made in the throat", "Try rounding your lips for 'u'"]
}
Keep corrections to max 3. Be encouraging. Score 0-100.`;
    const msg=`The lesson prompt was: "${prompt}"
Sample answer: "${sampleAnswer}"
Student said: "${spokenText}"
Analyze their French pronunciation and content. Be encouraging.`;
    try{
      const raw=await callClaude(sys,msg,400);
      const cleaned=raw.replace(/```json|```/g,"").trim();
      const parsed=JSON.parse(cleaned);
      setFeedback(parsed);
    }catch{
      setFeedback({score:75,overall:"Good attempt! Keep practicing your French pronunciation.",corrections:[],encouragement:"Every time you speak French, you improve! 🌟"});
    }
    setStage("feedback");
  };

  return <div style={{background:"linear-gradient(135deg,#FFF7ED,#FEF3C7)",borderRadius:16,padding:20,border:"2px solid #FCD34D"}}>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
      <span style={{fontSize:28}}>🎤</span>
      <div>
        <div style={{fontFamily:"Georgia,serif",fontSize:17,fontWeight:700,color:T.navy}}>Speaking Practice with Sophie</div>
        <div style={{fontSize:12,color:T.textSoft}}>{canRecord?"Say it out loud — French Canadian 🍁":"Listen-and-repeat mode on this device 🍁"}</div>
      </div>
    </div>

    {!canRecord&&<div style={{background:"#EFF6FF",border:"1px solid #BFDBFE",borderRadius:10,padding:"9px 12px",marginBottom:14,fontSize:12,color:"#1E40AF",lineHeight:1.5}}>
      🎧 Live mic scoring isn't available on this device. You'll hear the model phrase and practise it aloud yourself — just as effective for building the habit.
    </div>}

    <div style={{background:"rgba(255,255,255,0.7)",borderRadius:12,padding:14,marginBottom:14}}>
      <div style={{fontSize:12,fontWeight:700,color:T.textSoft,textTransform:"uppercase",letterSpacing:.8,marginBottom:6}}>💬 Say this:</div>
      <div style={{fontSize:15,fontWeight:600,color:T.navy,lineHeight:1.6,display:"flex",alignItems:"flex-start",gap:8}}>
        <span style={{flex:1}}>{sampleAnswer}</span>
        <SpeakBtn text={sampleAnswer} size={18}/>
      </div>
    </div>

    {stage==="ready"&&canRecord&&<>
      {transcript&&<div style={{background:"#fff",borderRadius:10,padding:12,marginBottom:12,fontSize:13,color:T.textMid,fontStyle:"italic"}}>Last attempt: "{transcript}"</div>}
      <button onClick={startRecording} style={{background:"#F97316",color:"#fff",border:"none",padding:"14px 28px",borderRadius:14,fontWeight:700,fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",gap:8,fontFamily:"system-ui,-apple-system,sans-serif"}}>
        🎤 Start Speaking
      </button>
      <div style={{fontSize:12,color:T.textSoft,marginTop:8}}>Uses your microphone · French Canadian dialect</div>
    </>}

    {/* Fallback: device has no speech recognition — practise aloud, then self-mark */}
    {stage==="ready"&&!canRecord&&<>
      <div style={{fontSize:13,color:T.textMid,lineHeight:1.6,marginBottom:12}}>🔊 Tap the speaker to hear the model, then say it aloud yourself a couple of times. Live scoring isn't available on this device — mark it done when you've practised it.</div>
      <button onClick={()=>onDone(true, 80)} style={{background:"#059669",color:"#fff",border:"none",padding:"14px 28px",borderRadius:14,fontWeight:700,fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",gap:8,fontFamily:"system-ui,-apple-system,sans-serif"}}>
        ✓ I practised saying it aloud
      </button>
    </>}

    {stage==="recording"&&<>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
        <div style={{width:14,height:14,borderRadius:"50%",background:"#EF4444",animation:"ring 1s infinite"}}/>
        <span style={{fontWeight:700,color:"#EF4444",fontSize:14}}>Recording... speak now!</span>
      </div>
      {transcript&&<div style={{background:"#fff",borderRadius:10,padding:12,marginBottom:12,fontSize:14,color:T.navy,fontStyle:"italic"}}>"{transcript}"</div>}
      <button onClick={stopRecording} style={{background:T.navy,color:"#fff",border:"none",padding:"12px 24px",borderRadius:12,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"system-ui,-apple-system,sans-serif"}}>
        ⏹ Done Speaking
      </button>
    </>}

    {stage==="processing"&&<div style={{textAlign:"center",padding:"20px 0"}}>
      <div style={{fontSize:32,animation:"float 1s infinite"}}>🧠</div>
      <div style={{marginTop:8,fontWeight:700,color:T.navy}}>Sophie is checking your French...</div>
      <div style={{fontSize:12,color:T.textSoft,marginTop:4}}>Checking pronunciation, grammar & fluency</div>
    </div>}

    {stage==="feedback"&&feedback&&<>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
        <div style={{width:64,height:64,borderRadius:"50%",background:feedback.score>=80?T.mint:feedback.score>=60?T.gold:"#F97316",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",flexShrink:0}}>
          <div style={{color:"#fff",fontWeight:900,fontSize:20}}>{feedback.score}</div>
          <div style={{color:"rgba(255,255,255,0.8)",fontSize:9}}>/ 100</div>
        </div>
        <div>
          <div style={{fontWeight:700,fontSize:15,color:T.navy}}>{feedback.overall}</div>
          <div style={{fontSize:13,color:T.mint,fontWeight:600,marginTop:3}}>{feedback.encouragement}</div>
        </div>
      </div>
      {feedback.corrections?.length>0&&<div style={{background:"#FEF9C3",borderRadius:10,padding:12,marginBottom:10}}>
        <div style={{fontSize:12,fontWeight:700,color:"#92400E",textTransform:"uppercase",letterSpacing:.8,marginBottom:6}}>💡 Quick Fixes</div>
        {feedback.corrections.map((c,i)=><div key={i} style={{fontSize:13,color:"#78350F",padding:"3px 0",display:"flex",gap:8}}><span>→</span>{c}</div>)}
      </div>}
      {feedback.phonetic_tips?.length>0&&<div style={{background:"#EDE9FE",borderRadius:10,padding:12,marginBottom:12}}>
        <div style={{fontSize:12,fontWeight:700,color:"#5B21B6",textTransform:"uppercase",letterSpacing:.8,marginBottom:6}}>🗣️ Pronunciation Tips</div>
        {feedback.phonetic_tips.map((t,i)=><div key={i} style={{fontSize:13,color:"#4C1D95",padding:"3px 0",display:"flex",gap:8}}><span>🔊</span>{t}</div>)}
      </div>}
      <div style={{display:"flex",gap:8}}>
        <button onClick={()=>{setStage("ready");setFeedback(null);}} style={{background:"rgba(255,255,255,0.8)",border:`1.5px solid ${T.border}`,padding:"10px 18px",borderRadius:10,fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:"system-ui,-apple-system,sans-serif",color:T.navy}}>Try Again 🔄</button>
        <button onClick={()=>onDone(feedback.score>=60, feedback.score)} style={{background:T.mint,color:"#fff",border:"none",padding:"10px 20px",borderRadius:10,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"system-ui,-apple-system,sans-serif"}}>Continue →</button>
      </div>
    </>}
  </div>;
}

// ─── AI WRITING CHECKER ───────────────────────────────────────────────────────
function AIWritingChecker({prompt, accepted, level, onResult}){
  const[val,setVal]=useState("");
  const[checking,setChecking]=useState(false);
  const[result,setResult]=useState(null);

  const checkWithAI=async()=>{
    if(!val.trim()) return;
    setChecking(true);
    const sys=`You are a French language teacher grading a Canadian learner at ${level} level.
Respond ONLY in JSON:
{
  "correct": true,
  "score": 90,
  "corrected": "The corrected version of their answer",
  "explanation": "ONE short sentence (max 12 words) on the key fix",
  "encouragement": "Max 3 words, e.g. 'Almost there!'"
}

GRADING RULES — be fair, not a pushover:
- Mark correct:FALSE if the answer is empty, gibberish/random letters, written in English, off-topic, or does NOT actually attempt what the prompt asked.
- Mark correct:TRUE only if the writing genuinely communicates the requested meaning in French. Minor spelling or accent mistakes are fine — judge the MEANING, not perfection.
- If unsure whether it's a real attempt, mark correct:FALSE.
Keep explanation to a single short sentence — never a paragraph. Be BRIEF.`;
    const msg=`Prompt: "${prompt}"
Acceptable answers include: ${accepted.join(", ")}
Student wrote: "${val}"
Is this correct or close enough? Give feedback.`;
    try{
      const raw=await callClaude(sys,msg,350);
      const cleaned=raw.replace(/```json|```/g,"").trim();
      const parsed=JSON.parse(cleaned);
      setResult(parsed);
      onResult(parsed.correct);
    }catch{
      // Fallback to simple check (only runs if the AI response can't be parsed).
      // Match against the more meaningful accepted phrases (length >= 4) so short
      // fragments like "ans" don't false-match inside words like "dans".
      const v=val.trim().toLowerCase();
      const pool=accepted.filter(a=>a.length>=4);
      const checkList=pool.length?pool:accepted;
      const ok=v.length>=3 && checkList.some(a=>v.includes(a.toLowerCase()));
      setResult({correct:ok,score:ok?85:40,corrected:accepted[0],explanation:ok?"Great answer!":"Not quite — see the correction.",encouragement:ok?"Bien joué!":"Try again!"});
      onResult(ok);
    }
    setChecking(false);
  };

  return <div>
    <div style={{position:"relative",marginBottom:10}}>
      <textarea value={val} onChange={e=>setVal(e.target.value)} disabled={!!result}
        placeholder="Écrivez votre réponse en français..."
        style={{width:"100%",padding:14,borderRadius:12,border:`2px solid ${result?(result.correct?T.mint:T.red):T.border}`,fontFamily:"system-ui,-apple-system,sans-serif",fontSize:15,color:T.text,background:T.card,resize:"none",minHeight:80,outline:"none",transition:"border-color 0.2s",boxSizing:"border-box"}}/>
      <div style={{position:"absolute",bottom:10,right:12,fontSize:11,color:T.textSoft}}>{val.length} chars · AI-checked 🤖</div>
    </div>

    {!result&&<button onClick={checkWithAI} disabled={!val.trim()||checking}
      style={{background:val.trim()&&!checking?T.blue:"#cbd5e1",color:"#fff",border:"none",padding:"11px 22px",borderRadius:10,fontWeight:700,fontSize:14,cursor:val.trim()&&!checking?"pointer":"not-allowed",fontFamily:"system-ui,-apple-system,sans-serif",display:"flex",alignItems:"center",gap:8}}>
      {checking?<><span style={{animation:"float 0.8s infinite"}}>🧠</span> AI Checking...</>:"✍️ Check with AI"}
    </button>}

    {result&&<div style={{background:result.correct?"linear-gradient(135deg,#D1FAE5,#ECFDF5)":"linear-gradient(135deg,#FEF3C7,#FFFBEB)",borderRadius:12,padding:14,border:`2px solid ${result.correct?"#6EE7B7":"#FCD34D"}`}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
        <span style={{fontSize:24}}>{result.correct?"✅":"💡"}</span>
        <div>
          <div style={{fontWeight:700,fontSize:15,color:result.correct?"#065F46":"#92400E"}}>{result.correct?"Correct! Well done! 🌟":"Close! Here's the correction:"}</div>
          <div style={{fontSize:13,color:result.correct?"#059669":"#92400E",marginTop:2}}>{result.encouragement}</div>
        </div>
        <div style={{marginLeft:"auto",width:40,height:40,borderRadius:"50%",background:result.correct?T.mint:T.gold,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:900,fontSize:13}}>{result.score}</div>
      </div>
      {!result.correct&&result.corrected&&<div style={{background:"rgba(255,255,255,0.7)",borderRadius:8,padding:10,marginBottom:8}}>
        <div style={{fontSize:11,fontWeight:700,color:T.textSoft,textTransform:"uppercase",letterSpacing:.8,marginBottom:4}}>✏️ Corrected:</div>
        <div style={{fontSize:14,fontWeight:600,color:T.navy,fontStyle:"italic"}}>{result.corrected}</div>
      </div>}
      <div style={{fontSize:13,color:result.correct?"#065F46":"#78350F",lineHeight:1.5}}>{result.explanation}</div>
    </div>}
  </div>;
}

// ─── AI HINT BUTTON ───────────────────────────────────────────────────────────
function AIHintButton({question, level}){
  const[hint,setHint]=useState(null);
  const[loading,setLoading]=useState(false);
  const[open,setOpen]=useState(false);
  const getHint=async()=>{
    if(open){setOpen(false);return;}
    setLoading(true);setOpen(true);
    const sys=`You are a warm French teacher helping a Canadian immigrant. Give a short, encouraging hint (2 sentences max) to help with this question. Don't give the answer directly. Be warm and specific.`;
    const msg=`Question type: ${question.type}\nQuestion: ${question.prompt||question.fr||""}\nLevel: ${level}`;
    const h=await callClaude(sys,msg,120);
    setHint(aiClean(h));setLoading(false);
  };
  return <div style={{position:"relative"}}>
    <button onClick={getHint}
      style={{padding:"12px 16px",background:"#F8FAFC",color:"#475569",border:"1px solid #E2E8F0",borderRadius:12,fontFamily:"system-ui,sans-serif",fontWeight:600,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",gap:6,transition:"all 0.15s"}}
      onMouseEnter={e=>{e.currentTarget.style.background="#F1F5F9";}}
      onMouseLeave={e=>{e.currentTarget.style.background="#F8FAFC";}}>
      💡 {loading?"...":open?"Hide":"Hint"}
    </button>
    {open&&hint&&<div style={{position:"absolute",bottom:"calc(100% + 8px)",left:0,right:0,background:"#0F172A",borderRadius:10,padding:"12px 14px",fontSize:12,color:"rgba(255,255,255,0.9)",lineHeight:1.6,zIndex:10,minWidth:220,boxShadow:"0 4px 20px rgba(0,0,0,0.2)"}}>
      <div style={{fontSize:10,color:"rgba(255,255,255,0.4)",marginBottom:5,fontWeight:700,textTransform:"uppercase",letterSpacing:.5}}>AI Hint</div>
      {hint}
      <div style={{position:"absolute",bottom:-5,left:14,width:10,height:10,background:"#0F172A",transform:"rotate(45deg)"}}/>
    </div>}
  </div>;
}


function PracticeScreen({companion}){
  const c=companion||COMPANIONS[0];
  const[msgs,setMsgs]=useState([]);
  const[input,setInput]=useState("");
  const[loading,setLoading]=useState(false);
  const[topic,setTopic]=useState(null);
  const[gameActive,setGameActive]=useState(null);
  const[qIdx,setQIdx]=useState(0);
  const[reveal,setReveal]=useState(false);
  const[score,setScore]=useState(0);
  const[timer,setTimer]=useState(60);
  const[running,setRunning]=useState(false);
  const[matchSel,setMatchSel]=useState(null);
  const[matchDone,setMatchDone]=useState([]);
  const[fillSel,setFillSel]=useState(null);
  const[shuffled,setShuffled]=useState([]);
  const[placed,setPlaced]=useState([]);
  const[bank,setBank]=useState([]);
  const timerRef=useRef();
  const bottomRef=useRef();

  const TOPICS=[
    {id:"daily",label:"Daily Life 🏠",prompt:"Let's practice everyday French conversation about daily routines, food, and life in Canada!"},
    {id:"work",label:"Work & Career 💼",prompt:"Let's practice professional French for the Canadian workplace — meetings, emails, and colleagues!"},
    {id:"health",label:"Health & Medical 🏥",prompt:"Let's practice French for medical appointments and health conversations in Canada!"},
    {id:"travel",label:"Getting Around 🚌",prompt:"Let's practice French for navigating Canadian cities — transit, directions, and travel!"},
    {id:"social",label:"Small Talk ☕",prompt:"Let's practice casual French conversation — the kind you'd have at a café or with neighbours!"},
    {id:"immigration",label:"Immigration & Services 🍁",prompt:"Let's practice French for immigration offices, government services, and official situations in Canada!"},
  ];

  const startConversation=async(t)=>{
    setTopic(t);
    setLoading(true);
    const sys=`You are ${c.name}, a warm and encouraging French language conversation partner for Canadian learners (${c.level} level).
Topic: ${t.prompt}
Rules:
- Speak MOSTLY in French with English explanations when helpful
- Keep messages SHORT (2-4 sentences max)
- Ask ONE question at a time to keep conversation going
- When the user makes a French error, gently correct it: "Almost! Say: [correction] 🌟"
- Be encouraging, Canadian-context focused, and patient
- You know the CLB levels and the TEF/TCF Canada exams well — reassure with specifics if asked
- NEVER make French feel hard: normalise mistakes, keep each step small and winnable, name real progress
- Use relevant emojis
- Always end with a question or prompt to keep conversation going`;
    const opening=await callClaude(sys,`Start our ${t.label} conversation! Greet me warmly in French and ask me an easy opening question.`,200);
    setMsgs([newMsg("assistant",aiClean(opening))]);
    setLoading(false);
  };

  const sendMessage=async()=>{
    if(!input.trim()||loading) return;
    const userMsg=newMsg("user",input);
    const newMsgs=[...msgs,userMsg];
    setMsgs(newMsgs);
    setInput("");
    setLoading(true);
    const sys=`You are ${c.name}, a warm French conversation partner for Canadian learners.
Topic: ${topic?.prompt}
Rules:
- Short responses (2-4 sentences)
- Gently correct French errors inline: "Presque! On dit: [correction] ✨"  
- Ask follow-up questions
- Be encouraging and Canadian-context focused
- NEVER make French feel hard: normalise mistakes, keep steps small, name progress
- Mix French with English explanations
- Use emojis`;
    const history=newMsgs.slice(-6).map(m=>`${m.role==="user"?"Student":"Teacher"}: ${m.text}`).join("\n");
    const reply=await callClaude(sys,`Conversation so far:\n${history}\n\nContinue naturally. Keep it short and ask a follow-up question.`,200);
    setMsgs(m=>[...m,newMsg("assistant",aiClean(reply))]);
    setLoading(false);
    setTimeout(()=>bottomRef.current?.scrollIntoView({behavior:"smooth"}),100);
  };

  // Games section
  const startGame=(g)=>{
    setGameActive(g);setQIdx(0);setReveal(false);setScore(0);
    setMatchSel(null);setMatchDone([]);setFillSel(null);setPlaced([]);
    if(g.id==="sentence")setBank([...(g.questions?.[0]?.words||[])].sort(()=>Math.random()-0.5));
    if(g.id==="speed"||g.id==="errors"){setTimer(60);setRunning(true);}
  };

  useEffect(()=>{
    if(running){
      timerRef.current=setInterval(()=>setTimer(t=>{if(t<=1){clearInterval(timerRef.current);setRunning(false);return 0;}return t-1;}),1000);
    }
    return()=>clearInterval(timerRef.current);
  },[running]);

  if(!topic&&!gameActive){
    return <div style={{padding:28,maxWidth:760,margin:"0 auto"}}>
      <div style={{fontFamily:"Georgia,serif",fontSize:26,fontWeight:900,color:T.navy,marginBottom:6}}>💬 Conversation with Sophie</div>
      <div style={{fontSize:15,color:T.textMid,marginBottom:28}}>Practise real French conversation with Sophie, your French tutor. Pick a topic to start!</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:14,marginBottom:36}}>
        {TOPICS.map(t=><div key={t.id} onClick={()=>startConversation(t)}
          style={{background:T.card,border:`2px solid ${T.border}`,borderRadius:16,padding:"20px 16px",cursor:"pointer",transition:"all 0.2s",textAlign:"center"}}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=T.blue;e.currentTarget.style.transform="translateY(-2px)";}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.transform="none";}}>
          <div style={{fontSize:32,marginBottom:8}}>{t.label.split(" ").pop()}</div>
          <div style={{fontWeight:700,fontSize:14,color:T.navy}}>{t.label.split(" ").slice(0,-1).join(" ")}</div>
        </div>)}
      </div>
      <div style={{fontFamily:"Georgia,serif",fontSize:20,fontWeight:700,color:T.navy,marginBottom:14}}>🎮 Practice Games</div>
      <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
        {(typeof GAMES!=="undefined"?GAMES:[]).map(g=><div key={g.id} onClick={()=>startGame(g)}
          style={{background:T.card,border:`2px solid ${T.border}`,borderRadius:14,padding:"14px 18px",cursor:"pointer",display:"flex",alignItems:"center",gap:10,transition:"all 0.2s"}}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=T.blue;}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;}}>
          <span style={{fontSize:22}}>{g.emoji}</span>
          <div>
            <div style={{fontWeight:700,fontSize:13,color:T.navy}}>{g.name}</div>
            <div style={{fontSize:11,color:T.textSoft}}>{g.desc}</div>
          </div>
        </div>)}
      </div>
    </div>;
  }

  // Conversation UI
  if(topic){
    return <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 64px)",maxWidth:760,margin:"0 auto"}}>
      {/* Header */}
      <div style={{padding:"14px 20px",background:T.card,borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:12}}>
        <button onClick={()=>{setTopic(null);setMsgs([]);}} style={{background:"none",border:`1.5px solid ${T.border}`,padding:"6px 12px",borderRadius:8,cursor:"pointer",fontSize:13,color:T.textMid,fontFamily:"system-ui,-apple-system,sans-serif"}}>← Back</button>
        <Avatar companion={c} size={36}/>
        <div>
          <div style={{fontWeight:700,fontSize:14,color:T.navy}}>{c.name} · {topic.label}</div>
          <div style={{fontSize:11,color:T.mint,fontWeight:600}}>Your French conversation partner 🍁</div>
        </div>
        <div style={{marginLeft:"auto",fontSize:12,color:T.textSoft}}>{msgs.length} exchanges</div>
      </div>

      {/* Messages */}
      <div style={{flex:1,overflowY:"auto",padding:"20px 20px 0"}}>
        {msgs.map((m,i)=><div key={m.id||i} style={{display:"flex",gap:10,marginBottom:16,flexDirection:m.role==="user"?"row-reverse":"row"}}>
          {m.role==="assistant"&&<Avatar companion={c} size={36}/>}
          <div style={{maxWidth:"75%",background:m.role==="user"?`linear-gradient(135deg,${T.blue},${T.navy})`:"#fff",color:m.role==="user"?"#fff":T.text,padding:"12px 16px",borderRadius:m.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px",fontSize:14,lineHeight:1.65,border:m.role==="assistant"?`1.5px solid ${T.border}`:"none",boxShadow:"0 2px 12px rgba(0,0,0,0.06)"}}>
            {m.text}
          </div>
        </div>)}
        {loading&&<div style={{display:"flex",gap:10,marginBottom:16}}>
          <Avatar companion={c} size={36}/>
          <div style={{background:"#fff",border:`1.5px solid ${T.border}`,padding:"12px 16px",borderRadius:"18px 18px 18px 4px",display:"flex",gap:6,alignItems:"center"}}>
            {[0,1,2].map(i=><div key={i} style={{width:8,height:8,borderRadius:"50%",background:T.blue,animation:`typeDot 1.2s infinite ${i*0.2}s`}}/>)}
          </div>
        </div>}
        <div ref={bottomRef}/>
      </div>

      {/* Input */}
      <div style={{padding:"14px 20px",background:T.card,borderTop:`1px solid ${T.border}`,display:"flex",gap:10,alignItems:"flex-end"}}>
        <textarea value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage();}}}
          placeholder="Écrivez en français... (or English is fine too!)"
          style={{flex:1,padding:"12px 14px",borderRadius:12,border:`1.5px solid ${T.border}`,fontFamily:"system-ui,-apple-system,sans-serif",fontSize:14,resize:"none",minHeight:44,maxHeight:120,outline:"none",color:T.text,lineHeight:1.5}}
          rows={1}/>
        <button onClick={sendMessage} disabled={!input.trim()||loading}
          style={{background:input.trim()&&!loading?T.blue:"#cbd5e1",color:"#fff",border:"none",padding:"12px 18px",borderRadius:12,fontWeight:700,fontSize:14,cursor:input.trim()&&!loading?"pointer":"not-allowed",fontFamily:"system-ui,-apple-system,sans-serif",flexShrink:0,transition:"all 0.2s"}}>
          {loading?"...":"Send →"}
        </button>
      </div>
    </div>;
  }

  // ── GAME UI ──
  if(gameActive){
    const g=gameActive;
    const backBtn=<button onClick={()=>{setGameActive(null);clearInterval(timerRef.current);}} style={{background:"none",border:"1.5px solid #E2E8F0",padding:"6px 14px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600,color:"#64748B",fontFamily:"system-ui",marginBottom:16}}>← Back to Games</button>;

    // SPEED RECALL
    if(g.id==="speed"){
      const q=g.questions[qIdx%g.questions.length];
      const done=timer===0||!running;
      return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontFamily:"Georgia,serif",fontSize:20,fontWeight:800,color:"#0F172A"}}>⚡ Speed Recall</div>
          <div style={{display:"flex",gap:12,alignItems:"center"}}>
            <div style={{fontSize:18,fontWeight:800,color:timer<10?"#EF4444":"#059669"}}>⏱ {timer}s</div>
            <div style={{fontSize:14,fontWeight:700,color:"#0F172A"}}>Score: {score}</div>
          </div>
        </div>
        {done?<div style={{textAlign:"center",padding:"40px 20px",background:"#fff",borderRadius:16,border:"1px solid #E2E8F0"}}>
          <div style={{fontSize:52,marginBottom:12}}>🏆</div>
          <div style={{fontFamily:"Georgia,serif",fontSize:24,fontWeight:800,color:"#0F172A",marginBottom:6}}>Time's up!</div>
          <div style={{fontSize:16,color:"#64748B",marginBottom:20}}>You scored <strong>{score}</strong> points</div>
          <button onClick={()=>startGame(g)} style={{padding:"12px 28px",background:"#0F172A",color:"#fff",border:"none",borderRadius:10,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"system-ui"}}>Play Again</button>
        </div>:<div>
          <div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",padding:"32px 24px",textAlign:"center",marginBottom:16}}>
            <div style={{fontFamily:"Georgia,serif",fontSize:36,fontWeight:800,color:"#0F172A",marginBottom:8}}>{q.fr}</div>
            {reveal&&<div style={{fontSize:20,color:"#059669",fontWeight:700,marginTop:12}}>→ {q.en}</div>}
          </div>
          <div style={{display:"flex",gap:10}}>
            {!reveal?<button onClick={()=>setReveal(true)} style={{flex:1,padding:"14px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontWeight:700,fontSize:15,cursor:"pointer",fontFamily:"system-ui"}}>Show Answer</button>
            :<><button onClick={()=>{setScore(s=>s+10);setQIdx(i=>i+1);setReveal(false);}} style={{flex:1,padding:"14px",background:"#059669",color:"#fff",border:"none",borderRadius:12,fontWeight:700,fontSize:15,cursor:"pointer",fontFamily:"system-ui"}}>✓ Got it! +10</button>
            <button onClick={()=>{setQIdx(i=>i+1);setReveal(false);}} style={{flex:1,padding:"14px",background:"#EF4444",color:"#fff",border:"none",borderRadius:12,fontWeight:700,fontSize:15,cursor:"pointer",fontFamily:"system-ui"}}>✗ Missed</button></>}
          </div>
        </div>}
      </div>;
    }

    // ERROR HUNTER
    if(g.id==="errors"){
      const q=(g.questions||[])[qIdx];
      const done=!q||timer===0;
      return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontFamily:"Georgia,serif",fontSize:20,fontWeight:800,color:"#0F172A"}}>🧩 Error Hunter</div>
          <div style={{fontSize:18,fontWeight:800,color:timer<10?"#EF4444":"#059669"}}>⏱ {timer}s · {score}pts</div>
        </div>
        {done?<div style={{textAlign:"center",padding:"40px",background:"#fff",borderRadius:16,border:"1px solid #E2E8F0"}}>
          <div style={{fontSize:48,marginBottom:12}}>🎯</div>
          <div style={{fontFamily:"Georgia,serif",fontSize:22,fontWeight:800,color:"#0F172A",marginBottom:8}}>Done! Score: {score}</div>
          <button onClick={()=>startGame(g)} style={{padding:"12px 24px",background:"#0F172A",color:"#fff",border:"none",borderRadius:10,fontWeight:700,cursor:"pointer",fontFamily:"system-ui"}}>Play Again</button>
        </div>:<div>
          <div style={{background:"#EFF6FF",borderRadius:12,padding:"14px 16px",marginBottom:14,fontSize:14,fontWeight:600,color:"#1E40AF"}}>{q.prompt}</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {[{text:q.answer,correct:true},{text:q.wrong,correct:false}].sort(()=>Math.random()-0.5).map((opt,i)=>
              <button key={i} onClick={()=>{if(opt.correct){setScore(s=>s+10);}setReveal(true);setTimeout(()=>{setQIdx(idx=>idx+1);setReveal(false);},1500);}}
                style={{padding:"14px 18px",borderRadius:12,border:"2px solid #E2E8F0",background:reveal?(opt.correct?"#ECFDF5":"#FEF2F2"):"#fff",fontSize:14,fontWeight:600,cursor:reveal?"default":"pointer",color:reveal?(opt.correct?"#059669":"#DC2626"):"#0F172A",textAlign:"left",fontFamily:"system-ui"}}>
                {opt.text}
              </button>
            )}
          </div>
          {reveal&&<div style={{marginTop:12,padding:"12px 14px",background:"#F8FAFC",borderRadius:10,fontSize:13,color:"#475569",lineHeight:1.6}}>{q.explain}</div>}
        </div>}
      </div>;
    }

    // WORD MATCH
    if(g.id==="match"){
      const pairs=g.pairs||[];
      const frWords=pairs.map(p=>p.fr);
      const enWords=[...pairs.map(p=>p.en)].sort(()=>Math.random()-0.5);
      return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{fontFamily:"Georgia,serif",fontSize:20,fontWeight:800,color:"#0F172A",marginBottom:6}}>🎯 Word Match</div>
        <div style={{fontSize:13,color:"#64748B",marginBottom:16}}>Tap a French word, then its English meaning. {matchDone.length}/{pairs.length} matched!</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",marginBottom:8}}>French</div>
            {frWords.map((fr,i)=>{
              const isDone=matchDone.includes(fr);
              const isSel=matchSel===fr;
              return <button key={i} disabled={isDone} onClick={()=>{
                if(matchSel&&matchSel!==fr){
                  const pair=pairs.find(p=>p.fr===matchSel);
                  setMatchSel(null);
                } else {setMatchSel(isSel?null:fr);}
              }} style={{display:"block",width:"100%",marginBottom:8,padding:"10px 12px",borderRadius:10,border:`2px solid ${isDone?"#10B981":isSel?"#2563EB":"#E2E8F0"}`,background:isDone?"#ECFDF5":isSel?"#EFF6FF":"#F8FAFC",fontSize:13,fontWeight:600,color:isDone?"#059669":isSel?"#2563EB":"#0F172A",cursor:isDone?"default":"pointer",textAlign:"left",textDecoration:isDone?"line-through":"none"}}>
                {fr}
              </button>;
            })}
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",marginBottom:8}}>English</div>
            {enWords.map((en,i)=>{
              const matchedPair=pairs.find(p=>p.en===en&&matchDone.includes(p.fr));
              const isDone=!!matchedPair;
              return <button key={i} disabled={isDone} onClick={()=>{
                if(!matchSel) return;
                const pair=pairs.find(p=>p.fr===matchSel);
                if(pair&&pair.en===en){
                  setMatchDone(d=>[...d,matchSel]);
                  setScore(s=>s+10);
                  setMatchSel(null);
                } else {
                  setMatchSel(null);
                }
              }} style={{display:"block",width:"100%",marginBottom:8,padding:"10px 12px",borderRadius:10,border:`2px solid ${isDone?"#10B981":"#E2E8F0"}`,background:isDone?"#ECFDF5":"#F8FAFC",fontSize:13,color:isDone?"#059669":"#475569",cursor:isDone?"default":"pointer",textAlign:"left"}}>
                {en}
              </button>;
            })}
          </div>
        </div>
        {matchDone.length===pairs.length&&<div style={{textAlign:"center",padding:"24px",background:"#ECFDF5",borderRadius:12,marginTop:16}}>
          <div style={{fontSize:32,marginBottom:8}}>🎉</div>
          <div style={{fontWeight:800,fontSize:18,color:"#059669",marginBottom:12}}>All matched! Score: {score}</div>
          <button onClick={()=>startGame(g)} style={{padding:"10px 24px",background:"#0F172A",color:"#fff",border:"none",borderRadius:10,fontWeight:700,cursor:"pointer",fontFamily:"system-ui"}}>Play Again</button>
        </div>}
      </div>;
    }

    // FILL THE GAP
    if(g.id==="fill"){
      const q=(g.questions||[])[qIdx];
      if(!q) return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{textAlign:"center",padding:"40px",background:"#fff",borderRadius:16}}>
          <div style={{fontSize:48,marginBottom:12}}>🎉</div>
          <div style={{fontFamily:"Georgia,serif",fontSize:22,fontWeight:800,color:"#0F172A",marginBottom:8}}>Complete! Score: {score}</div>
          <button onClick={()=>startGame(g)} style={{padding:"12px 24px",background:"#0F172A",color:"#fff",border:"none",borderRadius:10,fontWeight:700,cursor:"pointer",fontFamily:"system-ui"}}>Play Again</button>
        </div>
      </div>;
      return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
          <div style={{fontFamily:"Georgia,serif",fontSize:20,fontWeight:800,color:"#0F172A"}}>✏️ Fill the Gap</div>
          <div style={{fontSize:14,fontWeight:700,color:"#0F172A"}}>{qIdx+1}/{g.questions.length} · {score}pts</div>
        </div>
        <div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",padding:"24px",marginBottom:16,fontSize:17,fontWeight:600,color:"#0F172A",textAlign:"center"}}>
          {q.before} <span style={{borderBottom:"2px solid #2563EB",padding:"2px 8px",color:fillSel!==null?(fillSel===q.correct?"#059669":"#DC2626"):"#2563EB",fontStyle:"italic"}}>{fillSel!==null?q.options[fillSel]:"___"}</span> {q.after}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {q.options.map((opt,i)=>{
            const isSel=fillSel===i;
            const isC=fillSel!==null&&i===q.correct;
            const isW=fillSel!==null&&isSel&&i!==q.correct;
            return <button key={i} disabled={fillSel!==null} onClick={()=>{setFillSel(i);if(i===q.correct)setScore(s=>s+10);}}
              style={{padding:"12px",borderRadius:10,border:`2px solid ${isC?"#059669":isW?"#EF4444":"#E2E8F0"}`,background:isC?"#ECFDF5":isW?"#FEF2F2":"#F8FAFC",fontSize:14,fontWeight:600,color:isC?"#059669":isW?"#DC2626":"#0F172A",cursor:fillSel!==null?"default":"pointer",fontFamily:"system-ui"}}>
              {opt}
            </button>;
          })}
        </div>
        {fillSel!==null&&<>
          <div style={{marginTop:12,padding:"12px 14px",background:"#F8FAFC",borderRadius:10,fontSize:13,color:"#475569",lineHeight:1.6}}>{q.explain}</div>
          <button onClick={()=>{setQIdx(i=>i+1);setFillSel(null);}} style={{width:"100%",marginTop:10,padding:"13px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"system-ui"}}>Next →</button>
        </>}
      </div>;
    }

    // BUILD A SENTENCE
    if(g.id==="sentence"){
      const q=(g.questions||[])[qIdx];
      if(!q) return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{textAlign:"center",padding:"40px",background:"#fff",borderRadius:16}}>
          <div style={{fontSize:48,marginBottom:12}}>🎉</div>
          <div style={{fontFamily:"Georgia,serif",fontSize:22,fontWeight:800,color:"#0F172A",marginBottom:8}}>Complete! Score: {score}</div>
          <button onClick={()=>startGame(g)} style={{padding:"12px 24px",background:"#0F172A",color:"#fff",border:"none",borderRadius:10,fontWeight:700,cursor:"pointer",fontFamily:"system-ui"}}>Play Again</button>
        </div>
      </div>;
      const isCorrect=JSON.stringify(placed)===JSON.stringify(q.correct);
      return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
          <div style={{fontFamily:"Georgia,serif",fontSize:20,fontWeight:800,color:"#0F172A"}}>🔀 Build a Sentence</div>
          <div style={{fontSize:14,fontWeight:700}}>{qIdx+1}/{g.questions.length}</div>
        </div>
        <div style={{minHeight:56,padding:"12px",background:"#F8FAFC",borderRadius:12,border:`2px dashed ${reveal?isCorrect?"#059669":"#EF4444":"#CBD5E0"}`,display:"flex",flexWrap:"wrap",gap:8,alignItems:"center",marginBottom:14}}>
          {placed.length===0&&<span style={{color:"#CBD5E0",fontSize:13}}>Tap words to build...</span>}
          {placed.map((w,i)=><button key={i} onClick={()=>{setPlaced(p=>{const n=[...p];n.splice(i,1);return n;});setBank(b=>[...b,w]);setReveal(false);}}
            style={{padding:"6px 12px",borderRadius:50,background:"#0F172A",color:"#fff",border:"none",fontWeight:600,fontSize:13,cursor:"pointer"}}>{w}</button>)}
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:14}}>
          {bank.map((w,i)=><button key={i} onClick={()=>{setPlaced(p=>[...p,w]);setBank(b=>{const n=[...b];n.splice(i,1);return n;});}}
            style={{padding:"6px 12px",borderRadius:50,background:"#F1F5F9",border:"1.5px solid #E2E8F0",fontWeight:600,fontSize:13,cursor:"pointer",color:"#0F172A"}}>{w}</button>)}
        </div>
        {!reveal?<button onClick={()=>setReveal(true)} style={{width:"100%",padding:"13px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"system-ui"}}>Check</button>
        :<>
          <div style={{padding:"12px 14px",background:isCorrect?"#ECFDF5":"#FEF2F2",borderRadius:10,fontSize:13,color:isCorrect?"#059669":"#DC2626",fontWeight:700,marginBottom:8}}>{isCorrect?"✓ Correct!":"✗ "+q.correct.join(" ")}</div>
          <div style={{padding:"10px 14px",background:"#F8FAFC",borderRadius:10,fontSize:13,color:"#475569",marginBottom:10}}>{q.explain}</div>
          <button onClick={()=>{if(isCorrect)setScore(s=>s+10);setQIdx(i=>i+1);setPlaced([]);setBank([...(g.questions[qIdx+1]?.words||[])].sort(()=>Math.random()-0.5));setReveal(false);}}
            style={{width:"100%",padding:"13px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"system-ui"}}>Next →</button>
        </>}
      </div>;
    }

    // FLASHCARD
    if(g.id==="flashcard"){
      const card=(g.cards||[])[qIdx];
      if(!card) return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{textAlign:"center",padding:"40px"}}>
          <div style={{fontSize:48,marginBottom:12}}>🃏</div>
          <div style={{fontFamily:"Georgia,serif",fontSize:22,fontWeight:800,color:"#0F172A",marginBottom:12}}>All cards done!</div>
          <button onClick={()=>startGame(g)} style={{padding:"12px 24px",background:"#0F172A",color:"#fff",border:"none",borderRadius:10,fontWeight:700,cursor:"pointer",fontFamily:"system-ui"}}>Start Over</button>
        </div>
      </div>;
      return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
          <div style={{fontFamily:"Georgia,serif",fontSize:20,fontWeight:800,color:"#0F172A"}}>🃏 Flashcard Blitz</div>
          <div style={{fontSize:13,color:"#64748B"}}>{qIdx+1}/{g.cards.length}</div>
        </div>
        <div onClick={()=>setReveal(r=>!r)} style={{background:"#fff",borderRadius:20,border:"2px solid #E2E8F0",padding:"48px 24px",textAlign:"center",cursor:"pointer",minHeight:180,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 20px rgba(0,0,0,0.06)"}}>
          <div style={{fontFamily:"Georgia,serif",fontSize:32,fontWeight:800,color:"#0F172A",marginBottom:8}}>{reveal?card.en:card.fr}</div>
          <div style={{fontSize:12,color:"#94A3B8"}}>{reveal?"English":"French"} · Tap to flip</div>
        </div>
        <div style={{display:"flex",gap:10,marginTop:16}}>
          <button onClick={()=>{setQIdx(i=>i+1);setReveal(false);}} style={{flex:1,padding:"13px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"system-ui"}}>Next Card →</button>
        </div>
      </div>;
    }

    // LIGHTNING MATCH
    if(g.id==="quickmatch"){
      const pairs=g.pairs||[];
      return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{fontFamily:"Georgia,serif",fontSize:20,fontWeight:800,color:"#0F172A",marginBottom:6}}>⚡ Lightning Match</div>
        <div style={{fontSize:13,color:"#64748B",marginBottom:16}}>{matchDone.length}/{pairs.length} matched · Score: {score}</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div>{pairs.map((p,i)=>{const isDone=matchDone.includes(p.fr);const isSel=matchSel===p.fr;
            return <button key={i} disabled={isDone} onClick={()=>{
              if(matchSel&&matchSel!==p.fr){setMatchSel(null);}else{setMatchSel(isSel?null:p.fr);}
            }} style={{display:"block",width:"100%",marginBottom:8,padding:"10px 12px",borderRadius:10,border:`2px solid ${isDone?"#10B981":isSel?"#2563EB":"#E2E8F0"}`,background:isDone?"#ECFDF5":isSel?"#EFF6FF":"#F8FAFC",fontSize:13,fontWeight:600,color:isDone?"#059669":isSel?"#2563EB":"#0F172A",cursor:isDone?"default":"pointer",textDecoration:isDone?"line-through":"none"}}>
              {p.fr}
            </button>;})}
          </div>
          <div>{[...pairs].sort(()=>Math.random()-0.5).map((p,i)=>{const isDone=matchDone.some(fr=>pairs.find(pp=>pp.fr===fr&&pp.en===p.en));
            return <button key={i} disabled={isDone} onClick={()=>{
              if(!matchSel)return;
              const pair=pairs.find(pp=>pp.fr===matchSel);
              if(pair&&pair.en===p.en){setMatchDone(d=>[...d,matchSel]);setScore(s=>s+10);setMatchSel(null);}
              else{setMatchSel(null);}
            }} style={{display:"block",width:"100%",marginBottom:8,padding:"10px 12px",borderRadius:10,border:`2px solid ${isDone?"#10B981":"#E2E8F0"}`,background:isDone?"#ECFDF5":"#F8FAFC",fontSize:13,color:isDone?"#059669":"#475569",cursor:isDone?"default":"pointer"}}>
              {p.en}
            </button>;})}
          </div>
        </div>
        {matchDone.length===pairs.length&&<div style={{textAlign:"center",padding:"24px",background:"#ECFDF5",borderRadius:12,marginTop:16}}>
          <div style={{fontSize:32,marginBottom:8}}>⚡🎉</div>
          <div style={{fontWeight:800,fontSize:18,color:"#059669",marginBottom:12}}>Lightning fast! Score: {score}</div>
          <button onClick={()=>startGame(g)} style={{padding:"10px 24px",background:"#0F172A",color:"#fff",border:"none",borderRadius:10,fontWeight:700,cursor:"pointer",fontFamily:"system-ui"}}>Play Again</button>
        </div>}
      </div>;
    }

    // SPEAKING CHALLENGE
    if(g.id==="speaking"){
      const q=(g.questions||[])[qIdx];
      if(!q) return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{textAlign:"center",padding:"40px"}}>
          <div style={{fontSize:48,marginBottom:12}}>🎤</div>
          <div style={{fontFamily:"Georgia,serif",fontSize:22,fontWeight:800,color:"#0F172A",marginBottom:12}}>All challenges done!</div>
          <button onClick={()=>startGame(g)} style={{padding:"12px 24px",background:"#0F172A",color:"#fff",border:"none",borderRadius:10,fontWeight:700,cursor:"pointer",fontFamily:"system-ui"}}>Start Over</button>
        </div>
      </div>;
      return <div style={{padding:"20px 16px",maxWidth:600,margin:"0 auto"}}>
        {backBtn}
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
          <div style={{fontFamily:"Georgia,serif",fontSize:20,fontWeight:800,color:"#0F172A"}}>🎤 Speaking Challenge</div>
          <div style={{fontSize:13,color:"#64748B"}}>{qIdx+1}/{g.questions.length}</div>
        </div>
        <div style={{background:"#0F172A",borderRadius:16,padding:"24px",marginBottom:14,color:"#fff"}}>
          <div style={{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",marginBottom:8}}>Your prompt</div>
          <div style={{fontSize:15,lineHeight:1.7}}>{q.prompt}</div>
          <div style={{marginTop:12,fontSize:12,color:"rgba(255,255,255,0.5)"}}>⏱ Suggested: {q.time} seconds</div>
        </div>
        <button onClick={()=>setReveal(r=>!r)} style={{width:"100%",padding:"13px",background:reveal?"#F8FAFC":"#EFF6FF",color:reveal?"#475569":"#2563EB",border:`1.5px solid ${reveal?"#E2E8F0":"#BFDBFE"}`,borderRadius:12,fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:"system-ui",marginBottom:10}}>
          {reveal?"Hide sample answer":"Show sample answer"}
        </button>
        {reveal&&<>
          <div style={{padding:"14px 16px",background:"#F8FAFC",borderRadius:12,fontSize:13,lineHeight:1.8,color:"#334155",marginBottom:10,fontStyle:"italic"}}>{q.sample}</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
            {q.tips.map((tip,i)=><span key={i} style={{fontSize:12,padding:"4px 10px",background:"#FFFBEB",color:"#92400E",borderRadius:50,border:"1px solid #FCD34D"}}>💡 {tip}</span>)}
          </div>
        </>}
        <button onClick={()=>{setQIdx(i=>i+1);setReveal(false);}} style={{width:"100%",padding:"13px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"system-ui"}}>Next Challenge →</button>
      </div>;
    }

    return <div style={{padding:"20px 16px"}}>{backBtn}<div style={{textAlign:"center",padding:"40px",color:"#64748B"}}>Game not found</div></div>;
  }

  return null;
}

// ─── PERSONAL AI TUTOR ────────────────────────────────────────────────────────
// `lesson` prop: when set, Sophie enters structured teaching mode for that lesson
// (uses the lesson arc from src/sophie.js). When null, Sophie runs free chat mode.
function PersonalTutorScreen({companion, progress, startLevel, onNavigate, lesson, onTalkLive}){
  const c = companion||COMPANIONS[0];
  const level = SYLLABUS[startLevel]||SYLLABUS.foundation;
  const allL = Object.values(SYLLABUS).flatMap(l=>l.modules.flatMap(m=>m.lessons));
  const done = allL.filter(l=>progress[l.id]);
  const notDone = allL.filter(l=>!progress[l.id]);
  const [msgs,setMsgs] = useState([]);
  const [input,setInput] = useState("");
  const [loading,setLoading] = useState(false);
  const [mode,setMode] = useState("chat"); // chat | assessment | plan
  const bottomRef = useRef();
  const lastUserRef = useRef(null); // last learner message, for retry-after-error
  const authCtx = useAuth();

  // Build Sophie's system prompt using the new master pedagogy (see src/sophie.js
  // and syllabus/sophie-teacher-pedagogy.md). When a specific lesson is being
  // taught (lesson prop set), Sophie switches into structured teaching mode.
  // Otherwise she runs free-chat mode.
  const learnerName = (authCtx?.user?.displayName || "").split(" ")[0] || "the learner";
  const clbGoal = parseInt(typeof window!=="undefined" ? localStorage.getItem("franco_clb_goal") : "") || 5;
  const _tr = getTrack();
  const _weak = (()=>{ try{ return JSON.parse(localStorage.getItem("franco_review_pool")||"[]").slice(0,3).map(q=>q.prompt||q.fr||q.title||"a recent question"); }catch{ return []; } })();
  const learnerContext = buildSophieSystemPrompt({
    learner: {
      name: learnerName,
      level: `${level.label} (${level.cefrTag}, ${level.clbTag})`,
      completed: done.length,
      total: allL.length,
      recentLessons: done.slice(-3).map(l=>l.title),
      nextLessonTitle: notDone[0]?.title || "all done",
      clbGoal,
      track: `${_tr.label} (target CLB ${_tr.clb||"—"})`,
      weakSpots: _weak,
    },
    lesson: lesson || null,
  });

  const sendMessage = async(text) => {
    if(!text.trim()||loading) return;
    lastUserRef.current = text;
    const userMsg = newMsg("user", text);
    const newMsgs = [...msgs, userMsg];
    setMsgs(newMsgs);
    setInput("");
    setLoading(true);
    const history = newMsgs.slice(-8).map(m=>`${m.role==="user"?"Learner":"Tutor"}: ${m.text}`).join("");
    const reply = await callClaude(learnerContext, `${history}

Learner: ${text}

Tutor:`, 400);
    setMsgs(m=>[...m,newMsg("assistant",reply)]);
    setLoading(false);
    setTimeout(()=>bottomRef.current?.scrollIntoView({behavior:"smooth"}),100);
  };

  // Sophie's opening greeting — extracted so both first-mount and retry use it.
  const runGreeting = async() => {
    setLoading(true);
    const prompt = sophieOpener({
      learner: { name: learnerName, completed: done.length, nextLessonTitle: notDone[0]?.title },
      lesson: lesson || null,
    });
    const reply = await callClaude(learnerContext, prompt, 200);
    setMsgs([newMsg("assistant",reply)]);
    setLoading(false);
  };

  // Retry after an AI error: drop the trailing error bubble, then re-request a
  // reply for the existing conversation (no duplicate user bubble). If there's
  // no prior learner message, re-run the opening greeting.
  const retryAi = async() => {
    if(loading) return;
    const cleaned = msgs.filter(x=>aiError(x.text)==null);
    const lastMsg = cleaned[cleaned.length-1];
    if(lastMsg && lastMsg.role==="user"){
      setMsgs(cleaned);
      setLoading(true);
      const history = cleaned.slice(-8).map(m=>`${m.role==="user"?"Learner":"Tutor"}: ${m.text}`).join("");
      const reply = await callClaude(learnerContext, `${history}

Tutor:`, 400);
      setMsgs(m=>[...m,newMsg("assistant",reply)]);
      setLoading(false);
      setTimeout(()=>bottomRef.current?.scrollIntoView({behavior:"smooth"}),100);
    } else {
      await runGreeting();
    }
  };

  const quickPrompts = [
    "What should I focus on today?",
    "Quiz me on what I've learned",
    "Make me a study plan for this week",
    "Explain the passé composé simply",
    "Practice a job interview in French",
    "Help me with CLB speaking tips",
  ];

  useEffect(()=>{
    // Auto-greeting on mount (lesson teaching mode OR free chat).
    runGreeting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  return <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 64px)",maxWidth:800,margin:"0 auto"}}>
    {/* Header */}
    <div style={{padding:"14px 20px",background:"#fff",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:12}}>
      <Avatar companion={c} size={40} speaking={loading}/>
      <div style={{flex:1}}>
        <div style={{fontWeight:700,fontSize:15,color:T.navy}}>{c.name} — Your Personal Tutor</div>
        <div style={{fontSize:11,color:T.mint,fontWeight:600}}>● Personalized for your CLB journey · {done.length} lessons tracked</div>
      </div>
      <div style={{display:"flex",gap:6,alignItems:"center"}}>
        {SOPHIE_LIVE_ENABLED && onTalkLive && <button onClick={onTalkLive}
          style={{padding:"6px 12px",borderRadius:8,border:"none",background:"linear-gradient(135deg,#7C3AED,#2563EB)",color:"#fff",fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:800,fontSize:12,cursor:"pointer"}}>📹 Talk live</button>}
        {[{id:"chat",label:"💬 Chat"},{id:"assessment",label:"📝 Quiz Me"},{id:"plan",label:"📅 Study Plan"}].map(m=>(
          <button key={m.id} onClick={()=>{setMode(m.id);sendMessage(m.id==="assessment"?"Quiz me on my weak areas based on my progress":"Make me a personalized study plan for this week");}}
            style={{padding:"6px 12px",borderRadius:8,border:`1.5px solid ${mode===m.id?T.blue:T.border}`,background:mode===m.id?T.blueLight:"transparent",color:mode===m.id?T.blue:T.textMid,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:600,fontSize:12,cursor:"pointer"}}>
            {m.label}
          </button>
        ))}
      </div>
    </div>

    {/* Progress bar */}
    <div style={{background:T.surface,padding:"8px 20px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:12}}>
      <span style={{fontSize:11,color:T.textSoft,fontWeight:600}}>Your progress:</span>
      <div style={{flex:1,height:4,background:T.border,borderRadius:99,overflow:"hidden"}}>
        <div style={{height:"100%",width:`${Math.round((done.length/allL.length)*100)}%`,background:`linear-gradient(90deg,${T.blue},${T.mint})`,borderRadius:99}}/>
      </div>
      <span style={{fontSize:11,fontWeight:700,color:T.navy}}>{done.length}/{allL.length} lessons</span>
      <Pill variant="blue">{level.cefrTag}</Pill>
    </div>

    {/* Messages */}
    <div style={{flex:1,overflowY:"auto",padding:"20px"}}>
      {msgs.map((m,i)=>{
        const err = aiError(m.text);
        if(err!=null) return (
          <div key={m.id||i} style={{display:"flex",gap:10,marginBottom:16,alignItems:"flex-start"}}>
            <Avatar companion={c} size={36}/>
            <div style={{maxWidth:"78%",background:"#FEF2F2",border:"1.5px solid #FECACA",color:"#991B1B",padding:"12px 16px",borderRadius:"18px 18px 18px 4px",fontSize:14,lineHeight:1.6}}>
              <div style={{display:"flex",alignItems:"center",gap:7,fontWeight:700,marginBottom:4}}>⚠️ Couldn't reach the tutor</div>
              <div style={{marginBottom:10}}>{err}</div>
              <button onClick={retryAi} disabled={loading}
                style={{background:"#DC2626",color:"#fff",border:"none",borderRadius:8,padding:"7px 16px",fontSize:13,fontWeight:700,cursor:loading?"not-allowed":"pointer"}}>↻ Retry</button>
            </div>
          </div>
        );
        return (
        <div key={m.id||i} style={{display:"flex",gap:10,marginBottom:16,flexDirection:m.role==="user"?"row-reverse":"row",alignItems:"flex-start"}}>
          {m.role==="assistant"&&<Avatar companion={c} size={36}/>}
          <div style={{maxWidth:"78%",background:m.role==="user"?`linear-gradient(135deg,${T.blue},${T.navy})`:"#fff",color:m.role==="user"?"#fff":T.text,padding:"12px 16px",borderRadius:m.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px",fontSize:14,lineHeight:1.7,border:m.role==="assistant"?`1.5px solid ${T.border}`:"none",boxShadow:"0 2px 8px rgba(0,0,0,0.05)"}}>
            {m.text}
          </div>
        </div>
        );
      })}
      {loading&&<div style={{display:"flex",gap:10,marginBottom:16,alignItems:"flex-start"}}>
        <Avatar companion={c} size={36}/>
        <div style={{background:"#fff",border:`1.5px solid ${T.border}`,padding:"14px 18px",borderRadius:"18px 18px 18px 4px",display:"flex",gap:5}}>
          {[0,1,2].map(i=><div key={i} style={{width:7,height:7,borderRadius:"50%",background:T.blue,animation:`typeDot 1.2s infinite ${i*0.2}s`}}/>)}
        </div>
      </div>}
      <div ref={bottomRef}/>
    </div>

    {/* Quick prompts — show when few messages */}
    {msgs.length<=2&&!loading&&<div style={{padding:"0 20px 12px",display:"flex",gap:8,flexWrap:"wrap"}}>
      {quickPrompts.map(p=>(
        <button key={p} onClick={()=>sendMessage(p)}
          style={{padding:"7px 14px",background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:50,fontSize:12,fontWeight:600,color:T.navy,cursor:"pointer",fontFamily:"system-ui,-apple-system,sans-serif",transition:"all 0.2s"}}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=T.blue;e.currentTarget.style.color=T.blue;}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.color=T.navy;}}>
          {p}
        </button>
      ))}
    </div>}

    {/* Input */}
    <div style={{padding:"14px 20px",background:"#fff",borderTop:`1px solid ${T.border}`,display:"flex",gap:10,alignItems:"flex-end"}}>
      <textarea value={input} onChange={e=>setInput(e.target.value)}
        onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage(input);}}}
        placeholder={`Ask ${c.name} anything — grammar, practice, study tips...`}
        style={{flex:1,padding:"12px 14px",borderRadius:12,border:`1.5px solid ${T.border}`,fontFamily:"system-ui,-apple-system,sans-serif",fontSize:14,resize:"none",minHeight:44,maxHeight:120,outline:"none",color:T.text,lineHeight:1.5}}
        rows={1}/>
      <button onClick={()=>sendMessage(input)} disabled={!input.trim()||loading}
        style={{background:input.trim()&&!loading?T.blue:"#CBD5E0",color:"#fff",border:"none",padding:"12px 20px",borderRadius:12,fontWeight:700,fontSize:14,cursor:input.trim()&&!loading?"pointer":"not-allowed",fontFamily:"system-ui,-apple-system,sans-serif",flexShrink:0}}>
        {loading?"...":"Send →"}
      </button>
    </div>
  </div>;
}


function ProfileScreen({companion,progress,startLevel,onReset,user,guestMode,onAuthNav}){
  const[adminTaps,setAdminTaps]=useState(0);
  const[showAdmin,setShowAdmin]=useState(false);
  const[adminEmail,setAdminEmail]=useState("");
  const[adminDays,setAdminDays]=useState("31");
  const[adminMsg,setAdminMsg]=useState("");
  const[reminderOn,setReminderOn]=useState(()=>{ try{ return !!localStorage.getItem("franco_reminder_on"); }catch{ return false; } });
  const toggleReminder=async()=>{
    const n=await import("./notifications.js");
    if(reminderOn){ await n.disableDailyReminder(); setReminderOn(false); }
    else{
      const r=await n.enableDailyReminder(19,0);
      if(r.ok){ setReminderOn(true); }
      else if(r.reason==="denied"){ window.alert("Notifications are off for Franco. Turn them on in iPhone Settings → Franco → Notifications, then try again."); }
    }
  };
  const grantPremium=async()=>{
    if(!adminEmail.trim()){setAdminMsg("Enter an email");return;}
    try{
      const exp=Date.now()+(parseInt(adminDays)*24*60*60*1000);
      const db=getFirestore();
      const ref=collection(db,"premiumUsers");
      const q=query(ref,where("email","==",adminEmail.trim().toLowerCase()));
      const snap=await getDocs(q);
      if(!snap.empty){await updateDoc(snap.docs[0].ref,{premium:true,exp,grantedAt:Date.now()});}
      else{await addDoc(ref,{email:adminEmail.trim().toLowerCase(),premium:true,exp,grantedAt:Date.now()});}
      setAdminMsg("Done! "+adminEmail+" has premium for "+adminDays+" days!");
      setAdminEmail("");
    }catch(e){setAdminMsg("Error: "+e.message);}
  };
  const{logout, deleteAccount}=useAuth();
  const[trackId,setTrackId]=useState(()=>getTrack().id);
  const c=companion||COMPANIONS[0];
  const level=SYLLABUS[startLevel]||SYLLABUS.foundation;
  const allL=Object.values(SYLLABUS).flatMap(l=>l.modules.flatMap(m=>m.lessons));
  const done=allL.filter(l=>progress[l.id]);
  const xp=done.length*25;
  const isPremium=isPremiumUnlocked();
  const handleLogout=async()=>{ await logout(); window.location.reload(); };
  const displayName=user?.displayName||user?.email?.split("@")[0]||null;

  // ─── ACCOUNT DELETION (App Store 5.1.1(v)) ─────────────────────────────────
  // Self-serve flow: confirm → enter password → reauthenticate → delete →
  // wipe local progress → reload. Required for any iOS app that allows
  // account creation. Web also gets it for parity.
  const[showDelete,setShowDelete]=useState(false);
  const[deletePass,setDeletePass]=useState("");
  const[deleteConfirm,setDeleteConfirm]=useState("");
  const[deleteBusy,setDeleteBusy]=useState(false);
  const[deleteErr,setDeleteErr]=useState("");
  const handleDeleteAccount=async(e)=>{
    e?.preventDefault?.();
    setDeleteErr("");
    if(deleteConfirm!=="DELETE"){setDeleteErr('Please type DELETE to confirm.');return;}
    if(!deletePass){setDeleteErr('Enter your password.');return;}
    setDeleteBusy(true);
    try{
      await deleteAccount(deletePass);
      window.location.reload();
    }catch(e2){
      const code = e2?.code||"";
      const msg = code==="auth/invalid-credential" || code==="auth/wrong-password"
        ? "Incorrect password."
        : code==="auth/requires-recent-login"
          ? "Please sign out and sign back in, then try again."
          : (e2?.message || "Could not delete account. Please try again.");
      setDeleteErr(msg);
      setDeleteBusy(false);
    }
  };

  const Row=({emoji,label,onClick})=>(
    <div onClick={onClick} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 0",borderBottom:`1px solid ${T.border}`,cursor:"pointer"}}
      onMouseEnter={e=>e.currentTarget.style.opacity="0.7"}
      onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
      <span style={{fontSize:18,width:24,textAlign:"center"}}>{emoji}</span>
      <span style={{fontSize:14,color:T.navy,flex:1,fontWeight:500}}>{label}</span>
      <span style={{color:T.textSoft,fontSize:13}}>›</span>
    </div>
  );

  return <div style={{maxWidth:520,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:0}}>
    {/* Header logo */}
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",marginBottom:28}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
        <span style={{fontSize:20}}>🍁</span>
        <span style={{fontFamily:"Georgia,serif",fontSize:16,fontWeight:700,color:T.navy,letterSpacing:1}}>FRANCO</span>
      </div>
    </div>

    {/* Profile card */}
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,padding:"20px",marginBottom:16}}>
      <div style={{fontSize:18,fontWeight:700,color:T.navy,marginBottom:16}}>Profile</div>

      <div style={{marginBottom:12}}>
        <div style={{fontSize:12,color:T.textSoft,marginBottom:2}}>Email</div>
        <div style={{fontSize:14,fontWeight:600,color:T.navy}}>{guestMode?"Guest mode":user?.email||"—"}</div>
      </div>

      {!guestMode && <div style={{marginBottom:12}}>
        <div style={{fontSize:12,color:T.textSoft,marginBottom:2}}>Email verification</div>
        <div style={{fontSize:14,fontWeight:600,color:T.navy}}>{user?.emailVerified?"Verified ✓":"Pending"}</div>
      </div>}

      <div style={{marginBottom:4}}>
        <div style={{fontSize:12,color:T.textSoft,marginBottom:6}}>Subscription</div>
        <span style={{fontSize:12,fontWeight:600,padding:"4px 12px",borderRadius:50,background:isPremium?"#D1FAE5":"#F1F5F9",color:isPremium?"#065F46":T.textMid,border:`1px solid ${isPremium?"#6EE7B7":T.border}`}}>
          {isPremium?"Premium ✓":"Free Plan"}
        </span>
      </div>
    </div>

    {/* Learning goal / track switcher */}
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,padding:"20px",marginBottom:16}}>
      <div style={{fontSize:13,fontWeight:700,color:T.textSoft,marginBottom:12,letterSpacing:0.5}}>LEARNING GOAL</div>
      {TRACKS.map(t=>{
        const active=trackId===t.id;
        return <div key={t.id} onClick={()=>{ try{ localStorage.setItem("franco_track",t.id); localStorage.setItem("franco_clb_goal",String(t.clb||5)); }catch{}; setTrackId(t.id); }}
          style={{display:"flex",alignItems:"flex-start",gap:12,padding:"12px 14px",borderRadius:12,marginBottom:8,cursor:"pointer",border:`2px solid ${active?T.blue:T.border}`,background:active?T.blueLight:T.card}}>
          <div style={{fontSize:22}}>{t.emoji}</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:14,fontWeight:700,color:T.navy}}>{t.label} <span style={{fontSize:11,fontWeight:600,color:T.textSoft}}>· {t.sub}</span></div>
            <div style={{fontSize:11.5,color:T.textMid,marginTop:3,lineHeight:1.5}}>{t.blurb}</div>
          </div>
          {active&&<div style={{color:T.blue,fontSize:18}}>✓</div>}
        </div>;
      })}
      <div style={{fontSize:11,color:T.textSoft,marginTop:2,lineHeight:1.5}}>Changing your goal reorders which lessons Franco surfaces first and sets your mock-exam target.</div>
    </div>

    {/* More section */}
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,padding:"4px 20px 8px",marginBottom:16}}>
      <div style={{fontSize:13,fontWeight:700,color:T.textSoft,padding:"14px 0 8px",letterSpacing:0.5}}>More</div>
      {/* Web subscription row (Stripe). Hidden on iOS — App Store 3.1.1
          prohibits external payment links for digital subscriptions. */}
      {!IS_IOS_APP && <Row emoji="📈" label="Subscription" onClick={()=>{
        const n=adminTaps+1;
        setAdminTaps(n);
        if(n===3){setShowAdmin(true);setAdminTaps(0);}
        else{window.open("https://buy.stripe.com/7sY6oIaaYfe6c0K6Di2go00","_blank");}
      }}/>}

      {/* iOS-only: daily study reminder (on-device local notification). */}
      {IS_IOS_APP && <Row emoji="🔔" label={reminderOn?"Daily reminder: On (7:00 PM)":"Daily study reminder"} onClick={toggleReminder}/>}

      {/* iOS-only: Restore Purchases. Apple requires this in the UI for any
          app with subscriptions (StoreKit / Guideline 3.1.1). */}
      {IS_IOS_APP && <Row emoji="🔄" label="Restore Purchases" onClick={async ()=>{
        try {
          const { iapRestore } = await import("./iap.js");
          const result = await iapRestore();
          if (result.restored) { window.alert("Premium restored! Welcome back."); window.location.reload(); }
          else { window.alert("No previous purchases found on this Apple ID."); }
        } catch(e) { window.alert("Restore failed: " + (e?.message || "Unknown error")); }
      }}/>}
      {showAdmin&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
        <div style={{background:"#fff",borderRadius:16,padding:24,width:"100%",maxWidth:380}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <div style={{fontSize:16,fontWeight:800,color:"#0F172A"}}>Admin Panel</div>
            <button onClick={()=>{setShowAdmin(false);setAdminMsg("");}} style={{background:"none",border:"none",fontSize:20,cursor:"pointer"}}>x</button>
          </div>
          <div style={{fontSize:12,color:"#64748B",marginBottom:12}}>Grant premium to any user by email</div>
          <input value={adminEmail} onChange={e=>setAdminEmail(e.target.value)} placeholder="user@email.com"
            style={{width:"100%",padding:"10px 12px",border:"1px solid #E2E8F0",borderRadius:8,fontSize:13,outline:"none",marginBottom:10,boxSizing:"border-box"}}/>
          <select value={adminDays} onChange={e=>setAdminDays(e.target.value)}
            style={{width:"100%",padding:"10px 12px",border:"1px solid #E2E8F0",borderRadius:8,fontSize:13,marginBottom:12}}>
            <option value="31">1 month</option>
            <option value="62">2 months</option>
            <option value="93">3 months</option>
            <option value="365">1 year</option>
            <option value="3650">Lifetime</option>
          </select>
          <button onClick={grantPremium} style={{width:"100%",padding:"12px",background:"#0F172A",color:"#fff",border:"none",borderRadius:10,fontFamily:"system-ui",fontWeight:700,fontSize:14,cursor:"pointer",marginBottom:10}}>
            Grant Premium
          </button>
          {adminMsg&&<div style={{padding:"10px 12px",borderRadius:8,background:adminMsg.startsWith("Done")?"#ECFDF5":"#FEF2F2",fontSize:13,color:adminMsg.startsWith("Done")?"#059669":"#DC2626",fontWeight:600}}>{adminMsg}</div>}
        </div>
      </div>}
      <Row emoji="🍁" label="Immigration Services — Nimmi" onClick={()=>openExternal("https://www.nimmi.solutions")}/>
      <Row emoji="📊" label="Calculate Your PR Score — Nimmi" onClick={()=>openExternal("https://www.nimmi.solutions")}/>
      <Row emoji="✉️" label="Email — admin@junglelabsworld.com" onClick={()=>openExternal("mailto:admin@junglelabsworld.com")}/>
      <Row emoji="📞" label="Call — +1 604 902 8699" onClick={()=>openExternal("tel:+16049028699")}/>
      <Row emoji="💬" label="WhatsApp — +1 604 902 8699" onClick={()=>openExternal("https://wa.me/16049028699")}/>
      <Row emoji="🔄" label="Re-take Self Assessment" onClick={()=>{if(window.confirm("Reset your level selection?"))onReset();}}/>
      <div onClick={()=>openExternal(PRIVACY_URL)} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 0",cursor:"pointer"}}
        onMouseEnter={e=>e.currentTarget.style.opacity="0.7"}
        onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
        <span style={{fontSize:18,width:24,textAlign:"center"}}>🔒</span>
        <span style={{fontSize:14,color:T.navy,flex:1,fontWeight:500}}>Privacy Policy</span>
        <span style={{color:T.textSoft,fontSize:13}}>›</span>
      </div>
    </div>

    {/* Auth button */}
    {guestMode
      ? <button onClick={()=>onAuthNav("landing")} style={{width:"100%",padding:"15px",background:T.navy,color:"#fff",border:"none",borderRadius:14,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:15,cursor:"pointer",marginBottom:12}}>
          Create Account / Login
        </button>
      : <button onClick={handleLogout} style={{width:"100%",padding:"15px",background:T.surface,color:T.textMid,border:`1px solid ${T.border}`,borderRadius:14,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:15,cursor:"pointer",marginBottom:12}}>
          Sign Out
        </button>
    }

    {/* DELETE ACCOUNT — App Store 5.1.1(v) requires this for any app with account creation. */}
    {!guestMode && user && (
      <button onClick={()=>setShowDelete(true)} style={{
        width:"100%",padding:"13px",background:"transparent",
        color:"#DC2626",border:"1.5px solid #FCA5A5",borderRadius:14,
        fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:14,
        cursor:"pointer",marginBottom:12
      }}>Delete my account</button>
    )}

    {/* DELETE ALL DATA — for iOS guest-only mode (no account, but can still
         clear local progress). Also good for any guest-mode user. */}
    {(guestMode || IS_IOS_APP) && (
      <button onClick={()=>{
        if(window.confirm("Delete all your data?\\n\\nThis will permanently erase your progress, lessons completed, XP, streak, and any saved settings on this device. This cannot be undone.")){
          try {
            ["franco_progress","franco_companion","franco_level","franco_premium","franco_screen","franco_guest","franco_auth_screen","franco_streak","franco_xp","franco_achievements","franco_stats","franco_dark_mode"].forEach(k=>localStorage.removeItem(k));
          } catch {}
          window.location.reload();
        }
      }} style={{
        width:"100%",padding:"13px",background:"transparent",
        color:"#DC2626",border:"1.5px solid #FCA5A5",borderRadius:14,
        fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:14,
        cursor:"pointer",marginBottom:12
      }}>Delete all my data</button>
    )}

    {showDelete && (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
        <form onSubmit={handleDeleteAccount} style={{background:"#fff",borderRadius:16,maxWidth:400,width:"100%",overflow:"hidden",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}}>
          <div style={{background:"linear-gradient(135deg,#DC2626,#B91C1C)",padding:"22px 24px",color:"#fff"}}>
            <div style={{fontSize:20,fontWeight:800,marginBottom:4}}>Delete your account?</div>
            <div style={{fontSize:13,opacity:0.9}}>This cannot be undone. Your login, progress, and data will be permanently removed.</div>
          </div>
          <div style={{padding:"20px 24px"}}>
            <div style={{fontSize:12,color:T.textSoft,marginBottom:6,fontWeight:700,letterSpacing:0.5}}>TYPE "DELETE" TO CONFIRM</div>
            <input value={deleteConfirm} onChange={e=>setDeleteConfirm(e.target.value)} disabled={deleteBusy}
              placeholder="DELETE"
              style={{width:"100%",padding:"11px 13px",border:`1.5px solid ${deleteConfirm==="DELETE"?"#DC2626":T.border}`,borderRadius:10,fontSize:14,outline:"none",marginBottom:14,boxSizing:"border-box",fontFamily:"system-ui"}}/>
            <div style={{fontSize:12,color:T.textSoft,marginBottom:6,fontWeight:700,letterSpacing:0.5}}>YOUR PASSWORD</div>
            <input type="password" value={deletePass} onChange={e=>setDeletePass(e.target.value)} disabled={deleteBusy}
              placeholder="Current password"
              style={{width:"100%",padding:"11px 13px",border:`1.5px solid ${T.border}`,borderRadius:10,fontSize:14,outline:"none",marginBottom:14,boxSizing:"border-box",fontFamily:"system-ui"}}/>
            {deleteErr && <div style={{padding:"10px 12px",borderRadius:8,background:"#FEF2F2",color:"#B91C1C",fontSize:13,marginBottom:12,border:"1px solid #FECACA"}}>{deleteErr}</div>}
            <button type="submit" disabled={deleteBusy||deleteConfirm!=="DELETE"||!deletePass} style={{
              width:"100%",padding:"13px",background:(deleteBusy||deleteConfirm!=="DELETE"||!deletePass)?"#D1D5DB":"#DC2626",color:"#fff",border:"none",borderRadius:10,
              fontFamily:"system-ui",fontWeight:700,fontSize:14,
              cursor:(deleteBusy||deleteConfirm!=="DELETE"||!deletePass)?"not-allowed":"pointer",marginBottom:8
            }}>{deleteBusy?"Deleting…":"Permanently delete account"}</button>
            <button type="button" onClick={()=>{setShowDelete(false);setDeletePass("");setDeleteConfirm("");setDeleteErr("");}} disabled={deleteBusy} style={{
              width:"100%",padding:"11px",background:"transparent",border:`1px solid ${T.border}`,borderRadius:10,
              color:T.textMid,fontFamily:"system-ui",fontWeight:600,fontSize:14,
              cursor:deleteBusy?"not-allowed":"pointer"
            }}>Cancel</button>
          </div>
        </form>
      </div>
    )}

    <div style={{textAlign:"center",fontSize:12,color:T.textSoft}}>Powered by Jungle Labs</div>
  </div>;
}


function TopBar({screen,onNavigate,companion,progress,user,guestMode,onAuthNav}){
  const{logout}=useAuth();
  const isMobile=useIsMobile();
  const handleLogout=async()=>{ await logout(); window.location.reload(); };
  const nav=[
    {id:"dashboard",label:"Home",emoji:"🏠"},
    {id:"hub",label:"Learn",emoji:"📚"},
    {id:"skills",label:"Skills",emoji:"🎯"},
    {id:"practice",label:"Practice",emoji:"⚡"},
    {id:"profile",label:"Profile",emoji:"👤"},
  ];
  return <div style={{background:"#fff",borderBottom:"1px solid #E2E8F0",padding:"0 16px",paddingTop:"env(safe-area-inset-top)",display:"flex",alignItems:"center",minHeight:52,gap:0,position:"sticky",top:0,zIndex:100,boxShadow:"0 1px 4px rgba(0,0,0,0.04)"}}>
    {/* Logo */}
    <div style={{fontSize:18,fontWeight:800,color:"#0F172A",fontFamily:"Georgia,serif",marginRight:16,flexShrink:0}}>Franco 🍁</div>
    {/* Nav */}
    <div style={{display:"flex",gap:0,flex:1,justifyContent:isMobile?"center":"flex-start"}}>
      {nav.map(n=>(
        <button key={n.id} onClick={()=>onNavigate(n.id)}
          style={{padding:isMobile?"8px 10px":"8px 14px",border:"none",background:"none",color:screen===n.id?"#0F172A":"#94A3B8",fontFamily:"system-ui,sans-serif",fontWeight:screen===n.id?700:500,fontSize:isMobile?11:13,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:1,borderBottom:screen===n.id?"2px solid #0F172A":"2px solid transparent",borderRadius:0,transition:"all 0.15s"}}>
          {isMobile&&<span style={{fontSize:16}}>{n.emoji}</span>}
          <span>{isMobile?n.label:n.emoji+" "+n.label}</span>
        </button>
      ))}
    </div>
    {/* Auth */}
    {!isMobile&&(user
      ? <button onClick={handleLogout} style={{fontSize:12,fontWeight:600,padding:"6px 12px",borderRadius:8,border:"1px solid #E2E8F0",background:"none",color:"#64748B",cursor:"pointer",flexShrink:0}}>Sign out</button>
      : <button onClick={()=>onAuthNav("landing")} style={{fontSize:12,fontWeight:700,padding:"6px 14px",borderRadius:8,border:"none",background:"#0F172A",color:"#fff",cursor:"pointer",flexShrink:0}}>Sign in</button>
    )}
  </div>;
}


function AppInner(){
  const authCtx=useAuth();
  const{user,initializing,cloudProgress,cloudStreak,cloudXP}=authCtx;
  const[authScreen,setAuthScreen]=useLocalState("franco_auth_screen","landing");
  const[authParams,setAuthParams]=useState({});
  const[screen,setScreen]=useLocalState("franco_screen","welcome");
  const[companion,setCompanion]=useLocalState("franco_companion",null);
  const[startLevel,setStartLevel]=useLocalState("franco_level","foundation");
  const[progress,setProgress]=useLocalState("franco_progress",{});
  // Sync cloud progress when user logs in
  useEffect(()=>{
    if(cloudProgress && Object.keys(cloudProgress).length > Object.keys(progress).length){
      setProgress(cloudProgress);
    }
  },[cloudProgress]);
  const[activeLesson,setActiveLesson]=useState(null);
  const[paywallLesson,setPaywallLesson]=useState(null);
  const[tutorLesson,setTutorLesson]=useState(null); // when set, tutor enters lesson teaching mode
  const[showSophieLive,setShowSophieLive]=useState(false); // free owned talking-Sophie overlay
  const[showHeyGenCall,setShowHeyGenCall]=useState(false); // premium HeyGen live call
  // Live "Talk to Sophie": HeyGen (premium) when configured, else the free owned animation.
  const openLive = ()=>{
    if(HEYGEN_ENABLED){
      if(isPremiumUnlocked()) setShowHeyGenCall(true);
      else setPaywallLesson({title:"Live video call with Sophie 🎥"});
    } else { setShowSophieLive(true); }
  };
  const[guestMode,setGuestMode]=useLocalState("franco_guest",false);

  // Check if returning from Stripe payment (web only)
  useEffect(()=>{checkStripeSuccess();},[]);

  // Initialize Apple IAP (RevenueCat) on iOS. No-op on web.
  // After init, the local entitlement cache is populated automatically.
  useEffect(() => {
    if (!IS_IOS_APP) return;
    (async () => {
      try {
        const { iapInit } = await import("./iap.js");
        await iapInit();
      } catch (e) { /* ignore — iap.js logs its own warnings */ }
      try {
        // OTA live updates (Capgo): mark this bundle as good so it isn't rolled
        // back. No-op until the plugin is installed + the app rebuilt once.
        const { liveUpdateInit } = await import("./liveupdate.js");
        await liveUpdateInit();
      } catch (e) { /* ignore — liveupdate.js logs its own warnings */ }
    })();
    // Re-validate the subscription against RevenueCat whenever the app returns
    // to the foreground. Without this, a cancelled/expired subscription would
    // keep unlocking premium until the cached token's exp date (up to ~31 days).
    // RevenueCat is the ground truth; this just re-syncs the local mirror.
    const onResume = () => {
      if (document.visibilityState !== "visible") return;
      import("./iap.js").then(m => m.refreshEntitlementCache?.()).catch(()=>{});
    };
    document.addEventListener("visibilitychange", onResume);
    return () => document.removeEventListener("visibilitychange", onResume);
  }, []);

  useEffect(()=>{
    const s=document.createElement("style");
    s.textContent=`
      
      *{box-sizing:border-box;margin:0;padding:0;}
      body{background:${T.surface};}
      @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
        @keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.015)}}
        @keyframes confettiFall{0%{transform:translateY(-10px) rotate(0deg);opacity:1}100%{transform:translateY(100vh) rotate(720deg);opacity:0}}
        @keyframes popIn{0%{transform:scale(0.5);opacity:0}70%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}
        @keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
        @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
      @keyframes ring{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.03)}}
      @keyframes wave{0%,100%{transform:scaleY(.4);opacity:.5}50%{transform:scaleY(1);opacity:1}}
      @keyframes typeDot{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}
      ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px}
    `;
    document.head.appendChild(s);
    return()=>document.head.removeChild(s);
  },[]);

  // Navigate between auth screens
  const goAuth=(screenName, params={})=>{ setAuthScreen(screenName); setAuthParams(params); };

  // If Firebase is ready and user logs in, enter app
  useEffect(()=>{
    if(user){ setGuestMode(false); setAuthScreen("app"); }
  },[user]);

  const handleOnboard=(comp,lev)=>{setCompanion(comp);setStartLevel(lev);setScreen("dashboard");};
  const lessonDirtyRef=useRef(false); // true while a lesson is in progress & not yet saved
  const handleStartLesson=(lesson,level)=>{
    // App Store 3.1.1 — on iOS we ship guest-only / all-free since we can't link
    // out to Stripe for digital subscriptions. Web continues to use the paywall.
    // Lesson gating: if not free AND not premium, show paywall.
    // Web → Stripe paywall. iOS → IAP paywall (handled in PaywallModal).
    if(!isLessonFree(lesson.id) && !isPremiumUnlocked()){ logEvent("paywall_shown",{lessonId:lesson.id}); setPaywallLesson(lesson); return; }
    logEvent("lesson_start",{lessonId:lesson.id, level:level?.id, skill:lesson.skill});
    lessonDirtyRef.current=true;
    setActiveLesson({lesson,level}); setScreen("lesson");
  };
  // Practice this lesson 1-on-1 with Sophie (teaching mode).
  const handlePracticeWithSophie=(lesson)=>{
    setTutorLesson(lesson);
    setScreen("tutor");
  };
  // Skills tab: start an on-demand, focused practice set (synthetic lesson, not graded into progress).
  const handleStartPractice=(practiceLesson)=>{
    logEvent("skill_practice_start",{id:practiceLesson.id, skill:practiceLesson.skill});
    lessonDirtyRef.current=true;
    setActiveLesson({lesson:practiceLesson, level:null, back:"skills"});
    setScreen("lesson");
  };
  // Save a finished lesson's progress/streak/XP/SRS — NO navigation.
  const saveLessonProgress=(lessonId, score=4)=>{
    const newProgress={...progress,[lessonId]:true};
    const today=new Date().toISOString().split("T")[0];
    const lastDay=localStorage.getItem("franco_last_day");
    const yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);
    const yStr=yesterday.toISOString().split("T")[0];
    let newStreak=parseInt(localStorage.getItem("franco_streak")||"0");
    if(lastDay===today){ /* same day */ }
    else if(lastDay===yStr){ newStreak+=1; }
    else{ newStreak=1; }
    localStorage.setItem("franco_streak",String(newStreak));
    localStorage.setItem("franco_last_day",today);
    const newXP=(parseInt(localStorage.getItem("franco_xp")||"0"))+25;
    localStorage.setItem("franco_xp",String(newXP));
    setProgress(newProgress);
    // Base the review schedule on whichever store has data (cloud for signed-in
    // web users, localStorage for guests / the iOS app).
    let currentReviews=authCtx?.reviewSchedule||{};
    if(!authCtx?.user){
      try{ currentReviews=JSON.parse(localStorage.getItem("franco_reviews")||"{}"); }catch{ currentReviews={}; }
    }
    const prev=currentReviews[lessonId]||{};
    const nextReview=calcNextReview(prev.interval||0, prev.ef||2.5, score);
    const newReviews={...currentReviews,[lessonId]:nextReview};
    // Always persist locally so the SRS "due for review" surface works offline /
    // for guest users, not just signed-in web accounts.
    try{ localStorage.setItem("franco_reviews", JSON.stringify(newReviews)); }catch{}
    if(authCtx?.user && authCtx?.saveProgress){
      authCtx.saveProgress(newProgress, newXP, newStreak, newReviews);
    }
  };
  // Fires the moment a lesson reaches its results screen — so progress is saved even
  // if the learner leaves via ✕ or a nav tab instead of the Continue button.
  const handleLessonDone=(lessonId, score=4)=>{
    lessonDirtyRef.current=false;
    logEvent(activeLesson?.lesson?.practice?"practice_complete":"lesson_complete",{lessonId, score});
    if(activeLesson?.lesson?.practice) return; // practice sets aren't graded into progress
    saveLessonProgress(lessonId, score);
  };
  // The "Complete & Continue" button — navigation only (progress already saved on done).
  const handleLessonComplete=()=>{
    lessonDirtyRef.current=false;
    setScreen(activeLesson?.back||"hub");
    setActiveLesson(null);
  };
  // Nav tabs during a lesson: warn before abandoning unfinished (unsaved) work.
  const handleNav=(target)=>{
    if(screen==="lesson" && target!=="lesson" && lessonDirtyRef.current){
      if(!window.confirm("Leave this lesson? Your spot is saved — you can pick up where you left off.")) return;
      logEvent("lesson_abandon",{lessonId:activeLesson?.lesson?.id, via:"tab"});
      lessonDirtyRef.current=false;
    }
    if(screen==="lesson") stopFrench();
    setScreen(target);
  };

  // Loading spinner while Firebase initializes
  if(initializing) return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F7FAFF",flexDirection:"column",gap:16}}>
      <div style={{fontSize:48,animation:"float 1.5s ease-in-out infinite"}}>🍁</div>
      <div style={{fontFamily:"system-ui,-apple-system,sans-serif",fontSize:14,color:"#475569"}}>Loading Franco...</div>
    </div>
  );

  // Auth screens (not logged in and not guest).
  // On iOS we ship guest-only — never show auth screens. App Store guideline
  // 5.1.1(v) only applies when account creation is offered, so by skipping
  // the auth screens entirely on iOS we sidestep that whole requirement.
  const isAuthed = !!user || guestMode || IS_IOS_APP;
  if(!isAuthed){
    if(authScreen==="login") return <LoginScreen onNavigate={goAuth} prefillEmail={authParams.prefillEmail||""} notice={authParams.notice||""}/>;
    if(authScreen==="register") return <RegisterScreen onNavigate={goAuth}/>;
    return <AuthLandingScreen onNavigate={goAuth} onGuest={()=>{ setGuestMode(true); setAuthScreen("app"); }}/>;
  }

  // Main app
  const showNav=!["welcome","onboarding","mock"].includes(screen);
  return <div style={{fontFamily:"system-ui,-apple-system,sans-serif",background:T.surface,minHeight:"100vh",color:T.text}}>
    {showNav&&<TopBar screen={screen} onNavigate={handleNav} companion={companion} progress={progress} user={user} guestMode={guestMode} onAuthNav={goAuth}/>}
    <UpdateBanner/>
    {screen==="welcome"&&<WelcomeScreen onNext={()=>setScreen(companion?"dashboard":"onboarding")}/>}
    {screen==="onboarding"&&<OnboardingScreen onComplete={handleOnboard}/>}
    {screen==="dashboard"&&<DashboardScreen companion={companion} startLevel={startLevel} progress={progress} onNavigate={setScreen} user={user} guestMode={guestMode}/>}
    {screen==="hub"&&<HubScreen progress={progress} onStartLesson={handleStartLesson}/>}
    {screen==="lesson"&&activeLesson&&<LessonScreen lesson={activeLesson.lesson} level={activeLesson.level} companion={companion} onComplete={handleLessonComplete} onDone={handleLessonDone} onBack={()=>{if(lessonDirtyRef.current&&activeLesson)logEvent("lesson_abandon",{lessonId:activeLesson.lesson?.id, via:"exit"});lessonDirtyRef.current=false;setScreen(activeLesson.back||"hub");}} onPracticeWithSophie={handlePracticeWithSophie}/>}
    {screen==="skills"&&<SkillsScreen onStartPractice={handleStartPractice} onOpenMock={()=>setScreen("mock")}/>}
    {screen==="mock"&&<MockExamScreen onExit={()=>setScreen("skills")}/>}
    {screen==="practice"&&<PracticeScreen companion={companion}/>}
    {screen==="tutor"&&<PersonalTutorScreen companion={companion} progress={progress} startLevel={startLevel} onNavigate={(s)=>{if(s!=="tutor") setTutorLesson(null); setScreen(s);}} lesson={tutorLesson} onTalkLive={()=>setShowSophieLive(true)}/>}
    {screen==="profile"&&<ProfileScreen companion={companion} progress={progress} startLevel={startLevel} onReset={()=>{setProgress({});setScreen("dashboard");}} user={user} guestMode={guestMode} onAuthNav={goAuth}/>}
    {/* PaywallModal handles BOTH platforms internally:
         - Web: shows Stripe upgrade button
         - iOS: shows Apple IAP "Subscribe" button + "Restore Purchases"
        See PaywallModal definition for the platform branching logic. */}
    {paywallLesson && <PaywallModal lessonTitle={paywallLesson.title} onClose={()=>setPaywallLesson(null)}/>}
    {/* Always-available floating "Talk to Sophie live" button (hidden in lessons/mock/onboarding) */}
    {(SOPHIE_LIVE_ENABLED||HEYGEN_ENABLED) && showNav && screen!=="lesson" && !showSophieLive && !showHeyGenCall && !paywallLesson &&
      <button onClick={openLive} aria-label="Talk to Sophie live"
        style={{position:"fixed",right:16,bottom:"calc(env(safe-area-inset-bottom) + 18px)",zIndex:200,
          display:"flex",alignItems:"center",gap:8,padding:"12px 16px 12px 14px",borderRadius:50,border:"none",cursor:"pointer",
          background:"linear-gradient(135deg,#7C3AED,#2563EB)",color:"#fff",fontWeight:800,fontSize:13,
          boxShadow:"0 6px 22px rgba(124,58,237,0.45)"}}>
        <span style={{fontSize:18,lineHeight:1}}>📹</span> Talk to Sophie
      </button>}
    {showSophieLive && <SophieLive onClose={()=>setShowSophieLive(false)}/>}
    {showHeyGenCall && <LessonVideoCall lesson={null} learner={{ name:(typeof localStorage!=="undefined"&&localStorage.getItem("franco_name"))||"there" }} onClose={()=>setShowHeyGenCall(false)}/>}
  </div>;
}

// ─── IN-APP UPDATE BANNER ─────────────────────────────────────────────────────
// IMPORTANT: bump APP_VERSION to match the marketing version you set in Xcode
// for every App Store release. The banner compares this to the live App Store
// version (Apple's public iTunes lookup) and nudges users who are behind.
const APP_VERSION = "1.5";
const APPSTORE_ID = "6761284189";
const APPSTORE_URL = `https://apps.apple.com/app/id${APPSTORE_ID}`;

// Numeric, dot-separated version compare. Returns -1 if a<b, 0 if equal, 1 if a>b.
function cmpVersions(a, b){
  const pa=String(a||"").split(".").map(n=>parseInt(n,10)||0);
  const pb=String(b||"").split(".").map(n=>parseInt(n,10)||0);
  const len=Math.max(pa.length,pb.length);
  for(let i=0;i<len;i++){ const d=(pa[i]||0)-(pb[i]||0); if(d!==0) return d<0?-1:1; }
  return 0;
}
async function fetchAppStoreVersion(){
  try{
    const res=await fetch(`https://itunes.apple.com/lookup?id=${APPSTORE_ID}&_=${Date.now()}`);
    if(!res.ok) return null;
    const data=await res.json();
    return data?.results?.[0]?.version || null;
  }catch{ return null; }  // CORS/offline — fail silent, just don't show the banner
}
function UpdateBanner(){
  const[storeVer,setStoreVer]=useState(null);
  const[dismissed,setDismissed]=useState(false);
  useEffect(()=>{
    if(!IS_IOS_APP) return; // the web app auto-updates on reload — nothing to nudge
    let alive=true;
    fetchAppStoreVersion().then(v=>{
      if(!alive||!v) return;
      if(cmpVersions(APP_VERSION, v) < 0){
        // Don't re-nag if the user already dismissed this exact store version.
        if(localStorage.getItem("franco_update_dismissed")===v) return;
        setStoreVer(v);
      }
    });
    return()=>{ alive=false; };
  },[]);
  if(!storeVer||dismissed) return null;
  return <div style={{background:"#0F172A",color:"#fff",padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
    <span style={{fontSize:18,lineHeight:1}}>🚀</span>
    <div style={{flex:1,minWidth:0,fontSize:12.5,lineHeight:1.4}}>
      <b>A new version of Franco is available.</b> Update for the latest lessons and fixes.
    </div>
    <button onClick={()=>openExternal(APPSTORE_URL)} style={{background:"#3B82F6",color:"#fff",border:"none",borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:800,cursor:"pointer",flexShrink:0}}>Update</button>
    <button onClick={()=>{localStorage.setItem("franco_update_dismissed",storeVer);setDismissed(true);}} aria-label="Dismiss update notice" style={{background:"transparent",color:"rgba(255,255,255,0.55)",border:"none",fontSize:16,cursor:"pointer",flexShrink:0,padding:"0 4px"}}>✕</button>
  </div>;
}

// ─── LIVE SOPHIE (owned, in-app talking teacher) ──────────────────────────────
// Sophie's portrait "comes alive" — gentle breathing, a speaking glow, and an
// amplitude-driven mouth/lean synced to her ElevenLabs voice — while her brain
// (callClaude) answers questions and teaches in real time. Student talks via the
// mic (native speech recognition) or types. No HeyGen, no per-minute cost.
// Drop the portrait at public/sophie-live.png. We improve the animation over time.
const SOPHIE_LIVE_ENABLED = false; // turn on after dropping public/sophie-live.png + testing on device
const SOPHIE_IMG = "/sophie-live.png";
const MOUTH = { x: 50, y: 70 }; // % position of mouth in the portrait (tune to your image)

function SophieLive({ onClose }){
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("idle"); // idle | thinking | speaking | listening
  const [level, setLevel] = useState(0);
  const [started, setStarted] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  const [notice, setNotice] = useState("");
  const stopSpeakRef = useRef(null);
  const micRef = useRef(null);
  const bottomRef = useRef(null);
  const audioRef = useRef(null);       // ONE element, unlocked on the Start tap (iOS)
  const silenceRef = useRef(null);     // auto-submit timer when the speaker pauses
  const msgsRef = useRef([]);          // live mirror of msgs (avoids stale closure in voice callbacks)
  useEffect(()=>{ msgsRef.current = msgs; }, [msgs]);

  const learnerName = (typeof localStorage!=="undefined" && localStorage.getItem("franco_name")) || "there";
  const sysPrompt = useMemo(()=> buildSophieSystemPrompt({ learner:{ name:learnerName }, lesson:null }), [learnerName]);

  const speak = (text) => {
    if(stopSpeakRef.current) stopSpeakRef.current();
    setStatus("speaking");
    stopSpeakRef.current = speakSophie(text, { onLevel:setLevel, onEnd:()=>setStatus("idle"), audioEl:audioRef.current });
  };

  const ask = async (text) => {
    const q=(text||"").trim();
    if(!q || status==="thinking") return;
    const base = msgsRef.current;                       // read latest, not a stale render's msgs
    const next=[...base,{role:"user",text:q}];
    setMsgs(next); setInput(""); setStatus("thinking");
    const history=next.slice(-8).map(m=>`${m.role==="user"?"Student":"Sophie"}: ${m.text}`).join("\n");
    const raw = await callClaude(sysPrompt, `${history}\n\nReply as Sophie — warm, encouraging, brief (2–3 sentences). Teach French for life in Canada, mixing simple French with English. If they spoke French, gently correct and praise. Reply quickly and naturally, like a real teacher in conversation.`, 160);
    // If the AI call failed, don't speak the raw error sentence — give a short, human retry line.
    const reply = aiError(raw)!=null ? "Désolée, I lost the connection for a second — could you say that again?" : aiClean(raw);
    setMsgs(m=>[...m,{role:"assistant",text:reply}]);
    speak(reply);
  };

  // Unlock audio inside the user gesture so ElevenLabs plays later (iOS).
  const unlockAudio = () => {
    try{
      if(!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";
      audioRef.current.play().then(()=>{ try{audioRef.current.pause();}catch{} }).catch(()=>{});
    }catch{}
  };

  const start = async () => {
    unlockAudio();
    setStarted(true); setStatus("thinking");
    const opener=aiClean(await callClaude(sysPrompt, `Greet ${learnerName} warmly as their French teacher Sophie. 2 short sentences: introduce yourself and invite them to ask anything or practise speaking. Mix simple French and English.`, 140));
    setMsgs([{role:"assistant",text:opener}]); speak(opener);
  };

  const listen = async () => {
    if(status==="listening"){ try{ await micRef.current?.stop?.(); }catch{} return; }
    if(status==="speaking" && stopSpeakRef.current){ stopSpeakRef.current(); setStatus("idle"); }
    unlockAudio(); // tapping the mic is a gesture — keep audio unlocked for the reply
    setStatus("listening"); setNotice("");
    let finalText="";
    // Auto-submit ~2.2s after the speaker stops producing new words (only armed
    // once they've actually said something, so a slow start isn't cut off).
    const armSilence=()=>{ clearTimeout(silenceRef.current); silenceRef.current=setTimeout(()=>{ micRef.current?.stop?.(); }, 2200); };
    if(IS_IOS_APP){
      try{
        const mod="@capacitor-community/speech-recognition";
        const { SpeechRecognition } = await import(/* @vite-ignore */ mod);
        const perm=await SpeechRecognition.requestPermissions();
        if(perm && perm.speechRecognition==="denied"){ setNotice("Microphone access is off. Enable it in Settings → Franco → Microphone, or type your question below."); setStatus("idle"); return; }
        try{ await SpeechRecognition.removeAllListeners(); }catch{}
        await SpeechRecognition.addListener("partialResults",(d)=>{ const t=(d?.matches||[])[0]||""; if(t){ finalText=t; armSilence(); } });
        await SpeechRecognition.start({ language:"fr-CA", maxResults:1, partialResults:true, popup:false });
        micRef.current={ stop: async()=>{ clearTimeout(silenceRef.current); try{await SpeechRecognition.stop();}catch{} try{await SpeechRecognition.removeAllListeners();}catch{} finalText?ask(finalText):setStatus("idle"); } };
        setTimeout(()=>{ micRef.current?.stop?.(); }, 20000);
        return;
      }catch{ /* fall through to web speech */ }
    }
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(SR){
      const rec=new SR(); rec.lang="fr-CA"; rec.interimResults=true;
      rec.onresult=(e)=>{ finalText=Array.from(e.results).map(r=>r[0].transcript).join(" "); armSilence(); };
      rec.onerror=()=>{ clearTimeout(silenceRef.current); setStatus("idle"); };
      rec.onend=()=>{ clearTimeout(silenceRef.current); finalText?ask(finalText):setStatus("idle"); };
      micRef.current={ stop:()=>{try{rec.stop();}catch{}} };
      try{ rec.start(); }catch{ setStatus("idle"); }
      setTimeout(()=>{try{rec.stop();}catch{}},20000);
    } else { setNotice("Speaking isn't available on this device — type your question below."); setStatus("idle"); }
  };

  useEffect(()=>()=>{ if(stopSpeakRef.current) stopSpeakRef.current(); try{micRef.current?.stop?.();}catch{} clearTimeout(silenceRef.current); },[]);
  useEffect(()=>{ bottomRef.current?.scrollIntoView?.({behavior:"smooth"}); },[msgs]);

  const lastSophie=[...msgs].reverse().find(m=>m.role==="assistant");
  const portraitScale = 1 + (status==="speaking" ? level*0.06 : 0);

  return <div style={{position:"fixed",inset:0,zIndex:400,background:"linear-gradient(160deg,#0B1020,#1E1B4B)",display:"flex",flexDirection:"column"}}>
    {/* header */}
    <div style={{padding:"calc(env(safe-area-inset-top) + 10px) 16px 8px",display:"flex",alignItems:"center",gap:8}}>
      <div style={{width:9,height:9,borderRadius:"50%",background:status==="idle"?"#64748B":status==="listening"?"#F59E0B":"#10B981"}}/>
      <div style={{color:"#fff",fontSize:14,fontWeight:800}}>Sophie · Live</div>
      <div style={{flex:1}}/>
      <button onClick={()=>{ if(stopSpeakRef.current) stopSpeakRef.current(); try{micRef.current?.stop?.();}catch{} onClose(); }} style={{background:"rgba(255,255,255,0.12)",color:"#fff",border:"none",borderRadius:"50%",width:34,height:34,fontSize:16,cursor:"pointer"}}>✕</button>
    </div>

    {/* portrait */}
    <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",position:"relative",overflow:"hidden"}}>
      <div style={{position:"relative",width:"min(72vw,300px)",height:"min(72vw,300px)",borderRadius:"50%",overflow:"hidden",
        boxShadow:`0 0 ${30+ (status==="speaking"?level*60:0)}px rgba(124,58,237,${0.35+(status==="speaking"?level*0.5:0.15)})`,
        border:"3px solid rgba(255,255,255,0.15)",transition:"box-shadow 0.08s linear",
        animation:"breathe 4s ease-in-out infinite"}}>
        {imgOk
          ? <img src={SOPHIE_IMG} alt="Sophie" onError={()=>setImgOk(false)}
              style={{width:"100%",height:"100%",objectFit:"cover",objectPosition:"center top",transform:`scale(${portraitScale})`,transition:"transform 0.08s linear"}}/>
          : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(135deg,#7C3AED,#2563EB)",fontSize:72}}>👩‍🏫</div>}
        {/* mouth "talking" hint — soft shadow at the mouth that opens/closes with the pulse */}
        {imgOk && status==="speaking" && <div style={{position:"absolute",left:`${MOUTH.x}%`,top:`${MOUTH.y}%`,transform:"translate(-50%,-50%)",
          width:44,height:6+level*30,borderRadius:"50%",background:"rgba(35,8,8,0.4)",filter:"blur(4px)",opacity:0.35+level*0.55,transition:"all 0.05s linear"}}/>}
      </div>
    </div>

    {/* caption */}
    <div style={{minHeight:64,padding:"0 18px",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:"#E2E8F0",fontSize:15,lineHeight:1.5,textAlign:"center",maxWidth:560}}>
        {notice?<span style={{color:"#FCA5A5"}}>{notice}</span>
         :status==="thinking"?<span style={{opacity:0.7}}>Sophie is thinking…</span>
         :status==="listening"?<span style={{opacity:0.7}}>🎙️ Listening… speak now</span>
         :lastSophie?lastSophie.text:""}
      </div>
    </div>
    <div ref={bottomRef}/>

    {/* controls */}
    {!started
      ? <div style={{padding:"0 18px calc(env(safe-area-inset-bottom) + 24px)",display:"flex",justifyContent:"center"}}>
          <button onClick={start} style={{background:"linear-gradient(135deg,#7C3AED,#2563EB)",color:"#fff",border:"none",borderRadius:50,padding:"16px 32px",fontSize:16,fontWeight:800,cursor:"pointer"}}>▶ Start talking with Sophie</button>
        </div>
      : <div style={{padding:"10px 14px calc(env(safe-area-inset-bottom) + 14px)",display:"flex",gap:8,alignItems:"center"}}>
          <button onClick={listen} title="Speak"
            style={{flexShrink:0,width:52,height:52,borderRadius:"50%",border:"none",cursor:"pointer",fontSize:22,
              background:status==="listening"?"#EF4444":"linear-gradient(135deg,#7C3AED,#2563EB)",color:"#fff"}}>🎤</button>
          <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")ask(input);}}
            placeholder="Or type your question…"
            style={{flex:1,padding:"13px 16px",borderRadius:26,border:"none",fontSize:15,outline:"none",background:"rgba(255,255,255,0.12)",color:"#fff"}}/>
          <button onClick={()=>ask(input)} disabled={!input.trim()||status==="thinking"}
            style={{flexShrink:0,background:input.trim()?"#10B981":"rgba(255,255,255,0.12)",color:"#fff",border:"none",borderRadius:26,padding:"13px 18px",fontSize:15,fontWeight:800,cursor:input.trim()?"pointer":"default"}}>Send</button>
        </div>}
  </div>;
}

export default function App(){
  return <AuthProvider><AppInner/></AuthProvider>;
}
