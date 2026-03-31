import { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } from "react";
import { Home, BookOpen, Zap, User, ChevronDown, ChevronRight, Search, X, Play, RotateCcw, Check, Lock, Star, Flame, Target, Volume2, ArrowLeft, MessageCircle, Clock } from "lucide-react";
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, signOut, reload, updateProfile } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, onSnapshot } from "firebase/firestore";


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
    if(!_firebaseAuth){ setInitializing(false); return; }
    const unsub = onAuthStateChanged(_firebaseAuth, async u=>{
      setUser(u);
      setInitializing(false);
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

// ─────────────────────────────────────────────────────────────────────────────
// FOUNDATION — 20 lessons
// ─────────────────────────────────────────────────────────────────────────────
const FOUNDATION_LESSONS = [
  mkL("f-01","Bonjour Canada!",15,"mixed",
    "Imagine this: you just landed at Montreal airport. The customs officer smiles and says Bonjour! You freeze... what do you say? This happens to every new immigrant. Today you learn the 5 magic words that get you through your first day — and why saying them correctly makes Canadians light up with joy.",
    ["Bonjour (bohn-ZHOOR) = Hello","Merci (mare-SEE) = Thank you","S'il vous plait = Please","Oui (WEE) = Yes","Non (NOH) = No","Excusez-moi = Excuse me","De rien = You're welcome","Bonne journee = Have a good day"],
    [mcq("How do you greet someone in Quebec?",["Hola","Bonjour","Hello","Ciao"],1,"Bonjour = Hello or Good day! Used ALL day in Quebec. Always say it when entering any shop or office. One word, massive impact!",1),
     mcq("The customs officer helps you. You say:",["S'il vous plait","Merci beaucoup","Bonjour","Oui"],1,"Merci beaucoup = Thank you very much! Canadians appreciate this warmth — it shows you care.",1),
     {type:"match",prompt:"Match the French word to its English meaning",pairs:[["Oui","Yes"],["Non","No"],["Merci","Thank you"],["Bonjour","Hello"],["S'il vous plait","Please"]],explain:"These 5 words are your Day 1 survival kit in Canada!",diff:1},
     {type:"fill",before:"You walk into a pharmacy. You say",blank:"___",after:"to greet the pharmacist.",options:["Bonjour","Au revoir","Merci","Non"],correct:0,explain:"Always greet with Bonjour in Quebec! Even basic French shows respect and opens hearts.",diff:2},
     {type:"scene",story:"Amara arrives at Montreal airport. The officer says 'Bonjour Madame, bienvenue au Canada!' Amara smiles and wants to reply.",prompt:"What should Amara say?",options:["Bonjour! Merci!","Au revoir!","Non merci","Je ne sais pas"],correct:0,explain:"Bonjour! Merci! Simple and perfect. Respond to Bonjour with Bonjour. Canadians will love this!",diff:2},
     mcq("Leaving a store you say:",["Bonjour","Merci, bonne journee!","Oui","S'il vous plait"],1,"Merci, bonne journee! = Thank you, have a good day! Perfect way to leave any store in Quebec.",2),
     wr("Write how you greet someone entering a store in French",["bonjour","bonjour!","bonjour madame","bonjour monsieur"],"Bonjour! One word that opens every door in Quebec. Greeting people when you enter is the culture — not optional!",1)]),

  mkL("f-02","Sounds of French",20,"listening",
    "Your taxi driver from the airport is chatting and you cannot understand a word. Why? French sounds completely different from how it looks! Just 3 rules unlock everything. Rule 1: E says uh not ee. Rule 2: R comes from your throat like a soft gargle. Rule 3: H is always totally silent. Master these 3 and you will understand 30% more French immediately.",
    ["E = uh sound like the word the","E with accent = ay sound like cafe","R = guttural throat sound like gentle gargling","H = ALWAYS silent — never pronounce it!","OU = oo sound like moon","U = round lips for oo then say ee","ON = nasal buzz through nose like bon","AN = nasal like dans and France"],
    [mcq("How do you say cafe in French?",["KAF-ee","kaf-AY","KAY-fay","kaf-EE"],1,"Cafe = kaf-AY! The accent on e always makes the ay sound. You will see cafes everywhere in Quebec — now you know how to say it like a local!",1),
     mcq("How is hopital (hospital) pronounced?",["HOH-pee-tal","oh-pee-TAL","hoh-PEE-tal","hoh-spee-tal"],1,"oh-pee-TAL! H is always silent so we start with oh. In Quebec you will need this word — knowing it correctly helps in emergencies!",1),
     {type:"match",prompt:"Match each letter to how it sounds in French",pairs:[["E","uh like the"],["E accent","ay like say"],["R","guttural throat"],["H","always silent"],["OU","oo like moon"]],explain:"These 5 sound rules unlock French pronunciation completely. Once you know them you can read ANY French word out loud!",diff:1},
     mcq("The French letter H is:",["sometimes silent","always silent","only silent at end","pronounced like English H"],1,"H is ALWAYS silent in French — no exceptions! hopital = oh-pee-tal, homme = omm, heure = ur. One of the most common mistakes English speakers make!",1),
     mcq("How do you say bonjour correctly?",["BON-joor","bon-ZHOOR","BON-jour","bohn-JUR"],1,"bon-ZHOOR! The J makes a zh sound like the s in measure. The R is guttural from the back of your throat. Say it right!",2),
     {type:"scene",story:"Priya calls the hospital in Montreal. The receptionist answers in French. Priya needs to say she has an appointment.",prompt:"How does Priya pronounce hopital?",options:["HOH-pee-tal","oh-pee-TAL","hoh-SPEE-tal","hoh-pee-TAL"],correct:1,explain:"oh-pee-TAL — H is always silent. Pronouncing medical words correctly helps the person understand you immediately. This could save your life!",diff:2},
     mcq("The French U sound in tu (you) is made by:",["Saying oo normally","Rounding lips for oo then trying to say ee","Saying you quickly","Opening mouth wide"],1,"French U does not exist in English! Round lips tight for oo then try to say ee. The tension IS the French U. Tu, rue, lune — practice this!",3),
     wr("Write the French word for coffee",["cafe","café"],"Cafe! kaf-AY. One of the most common words in Quebec. Knowing how to say it correctly — with the ay sound at the end — shows you understand French pronunciation!",1)]),

  mkL("f-03","Who Are You?",20,"speaking",
    "At every government office, doctor, school registration, job interview — they always ask Comment vous appelez-vous? which means What is your name? Today you learn the 4 sentences that introduce you completely in French. By the end you can handle any first meeting in Quebec: name, age, origin, city. These 4 sentences will serve you for years.",
    ["Je m'appelle... = My name is...","J'ai X ans = I am X years old","Je viens de... = I come from...","J'habite a... = I live in...","Je suis... = I am (nationality)","Enchante(e) = Nice to meet you","Comment vous appelez-vous? = What is your name?","D'ou venez-vous? = Where are you from?"],
    [mcq("How do you say My name is in French?",["Je suis...","Je m'appelle...","J'ai...","J'habite..."],1,"Je m'appelle = My name is (literally I call myself). Always use this for your name — never Je suis name. This is the first phrase in every French introduction!",1),
     mcq("How do you say I am 30 years old in French?",["Je suis 30 ans","J'habite 30 ans","J'ai 30 ans","Je viens 30 ans"],2,"J'ai 30 ans! French uses AVOIR to have for age. Literally I have 30 years. Never say Je suis 30 ans — that is a very common mistake!",1),
     {type:"match",prompt:"Match the French phrase to its meaning",pairs:[["Je m'appelle Sara","My name is Sara"],["J'ai 28 ans","I am 28 years old"],["Je viens d'Inde","I come from India"],["J'habite a Montreal","I live in Montreal"],["Enchante!","Nice to meet you!"]],explain:"Put these 5 together and you have a complete French introduction! Practice saying all 5 about yourself right now.",diff:1},
     {type:"fill",before:"Je",blank:"___",after:"a Montreal. I live in Montreal.",options:["suis","m'appelle","habite","viens"],correct:2,explain:"J'habite a = I live in. Always use a before city names. J'habite a Montreal, J'habite a Toronto. This appears on virtually every form you fill in Canada!",diff:2},
     mcq("Ravi is from India. How does he say this in French?",["Je suis d'Inde","Je viens d'Inde","J'habite d'Inde","Je m'appelle d'Inde"],1,"Je viens de = I come from. Before a vowel de becomes d'. Je viens d'Inde, de France, du Canada. This is the correct way to say your country of origin!",2),
     {type:"scene",story:"Ravi is at his first day of French class. The teacher says Presentez-vous! meaning Introduce yourself! Ravi is 28, from India, lives in Montreal.",prompt:"Which introduction is correct?",options:["Je m'appelle Ravi. J'ai 28 ans. Je viens d'Inde. J'habite a Montreal.","Je suis Ravi. Je suis 28 ans. Je suis d'Inde. Je suis a Montreal.","Mon nom est Ravi. J'ai 28. Inde. Montreal.","Bonjour Ravi 28 India Montreal."],correct:0,explain:"Perfect! Je m'appelle not je suis for names. J'ai 28 ans not je suis. Je viens d'Inde with d before vowel. J'habite a Montreal. Memorize this pattern!",diff:2},
     mcq("How do you say nice to meet you?",["Bonjour","Au revoir","Enchante","Merci"],2,"Enchante! Said when meeting someone for the first time. If you are a woman add an e: Enchantee. It is a warm and elegant way to greet new people in Quebec!",2),
     wr("Write a complete introduction in French with your name and where you live",["je m'appelle","j'habite","j'ai","je viens"],"Excellent! This introduction works at government offices, schools, job interviews, and meeting neighbours. You are ready for real Canadian life!",2)]),

  mkL("f-04","Numbers That Matter",20,"listening",
    "Your first bill arrives in Quebec. The cashier says vingt-trois dollars — how much is that? You need to fill out a form with your phone number. The doctor asks your age. Numbers are everywhere in daily Canadian life and getting them wrong causes real problems. Today you learn 1 to 30 — enough for dates, ages, addresses, and prices.",
    ["1-5: un, deux, trois, quatre, cinq","6-10: six, sept, huit, neuf, dix","11-16: onze, douze, treize, quatorze, quinze, seize","17-19: dix-sept, dix-huit, dix-neuf","20: vingt | 21: vingt et un | 22: vingt-deux","30: trente | 31: trente et un","100: cent | 1000: mille","premier = first | deuxieme = second"],
    [mcq("What is trois in English?",["2","3","4","13"],1,"Trois = 3! Pronounced twah. The S is silent. You will hear this constantly: trois dollars, trois personnes, trois heures.",1),
     mcq("What is vingt in English?",["12","21","20","200"],2,"Vingt = 20! Pronounced van — the T and G are silent. Vingt et un = 21, vingt-deux = 22. Vingt appears constantly in prices and ages.",1),
     {type:"match",prompt:"Match the French number to its value",pairs:[["cinq","5"],["dix","10"],["quinze","15"],["vingt","20"],["trente","30"]],explain:"Cinq 5, dix 10, quinze 15, vingt 20, trente 30 — these multiples of 5 are the most useful numbers to learn first!",diff:1},
     mcq("The cashier says vingt-trois dollars. How much?",["13 dollars","20 dollars","23 dollars","32 dollars"],2,"Vingt 20 plus trois 3 = vingt-trois = 23! Knowing your numbers means you will never be confused at checkout in Quebec.",2),
     {type:"fill",before:"Mon numero de telephone est cinq, un, quatre,",blank:"___",after:", sept, huit, neuf, zero.",options:["deux","trois","cinq","six"],correct:1,explain:"Trois = 3! Phone numbers in Quebec are said digit by digit. Practice saying your own phone number in French — it comes up at every appointment!",diff:2},
     {type:"scene",story:"Sara is at the government office. The agent asks for her postal code H3A 2T6. She needs to say the numbers in French.",prompt:"How does Sara say 3 and 2 in French?",options:["trois et deux","three and two","trente et vingt","trois, deux"],correct:3,explain:"Trois, deux — numbers in postal codes and phone numbers are said one digit at a time. H trois A deux T six. Practice your own postal code!",diff:2},
     mcq("How do you say 25 in French?",["vingt et cinq","vingt-cinq","cinq-vingt","deux-cinq"],1,"Vingt-cinq! Numbers 22 to 29 use a hyphen: vingt-deux, vingt-trois, vingt-cinq. Only 21, 31, 41 use et un: vingt et un!",2),
     wr("Write the number 23 in French words",["vingt-trois","vingt trois"],"Vingt-trois! Vingt 20 plus trois 3. The hyphen is important in writing. Now you can write any number on Canadian forms!",2)]),

  mkL("f-05","Your New Home",25,"mixed",
    "Finding an apartment in Quebec is one of the first big challenges for immigrants. The landlord calls and asks questions in French. You need to understand: how many rooms, what floor, how much per month. Today is based on a real scenario — Sara calls about an apartment she saw on Kijiji. By the end you will know all the vocabulary to find your first home in French Canada.",
    ["un appartement = an apartment","un loyer = rent","une chambre = a bedroom","la salle de bain = bathroom","la cuisine = kitchen","le salon = living room","au premier etage = on the first floor","C'est combien? = How much is it?","C'est disponible quand? = When is it available?","Je suis interesse(e) = I am interested"],
    [mcq("What does loyer mean?",["bedroom","bathroom","rent","kitchen"],2,"Un loyer = rent! Every apartment listing in Quebec mentions the loyer. Le loyer est de 1200 dollars par mois = The rent is 1200 dollars per month.",1),
     mcq("What is la salle de bain?",["the living room","the bathroom","the bedroom","the kitchen"],1,"La salle de bain = the bathroom (literally the room of bath). Key word for apartment hunting! Always check how many salles de bain are included.",1),
     {type:"match",prompt:"Match the French room name to English",pairs:[["le salon","living room"],["la cuisine","kitchen"],["une chambre","a bedroom"],["la salle de bain","bathroom"],["le balcon","balcony"]],explain:"These are the 5 main rooms of any Quebec apartment! Knowing them lets you understand any listing on Kijiji or through an agent.",diff:1},
     {type:"fill",before:"Sara asks: C'est",blank:"___",after:"par mois? How much per month?",options:["combien","quand","ou","disponible"],correct:0,explain:"C'est combien? = How much is it? The most useful question for any transaction in Quebec. Combien means how much or how many.",diff:2},
     mcq("The landlord says L'appartement a deux chambres et un salon. What does this mean?",["2 bathrooms and a kitchen","2 bedrooms and a living room","2 floors and a balcony","2 kitchens and a room"],1,"Deux chambres = 2 bedrooms, un salon = a living room! Chambres always means bedrooms in apartment context. Now you can understand any Quebec listing!",2),
     {type:"scene",story:"Sara calls about an apartment. The landlord says: Bonjour, l'appartement est au deuxieme etage, loyer 1100 dollars par mois, disponible le 1er juillet.",prompt:"What did Sara learn about the apartment?",options:["2nd floor 1100 per month available July 1st","1st floor 1100 per month available June 1st","2nd floor 1000 per month available July 1st","3rd floor 1100 per month available July 1st"],correct:0,explain:"Deuxieme etage = 2nd floor, 1100 par mois = 1100 per month, disponible le 1er juillet = available July 1st. You just understood a real French phone call — incredible progress!",diff:3},
     mcq("How do you say I am interested in French?",["Je suis disponible","Je suis interesse","Je viens interesse","C'est combien"],1,"Je suis interesse! Or interessee if you are a woman. This phrase works on the phone, by email, or in person. Simple and professional!",2),
     wr("Write how you ask about the price of an apartment in French",["c'est combien","combien","quel est le loyer","le loyer"],"C'est combien le loyer? A natural perfect question any Quebecer would understand immediately. You will use this in real life very soon!",2)])
