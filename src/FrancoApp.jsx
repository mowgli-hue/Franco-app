import { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } from "react";
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, signOut, reload, updateProfile } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, onSnapshot, deleteDoc, collection, addDoc, getDocs, updateDoc, query, where } from "firebase/firestore";


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
      {type:"tap",fr:"café",opts:["kaf-AY","KAF-ee","KAY-fay","kaf-EE"],correct:0,explain:"Café = kaf-AY! The accent on é always makes the 'ay' sound. You'll see cafés everywhere in Quebec — now you know how to say it like a local!",diff:1},
      {type:"tap",fr:"hôpital",opts:["HOH-pee-tal","oh-pee-TAL","hoh-PEE-tal","hoh-spee-tal"],correct:1,explain:"oh-pee-TAL! H is silent — we start with 'oh'. The accent on ô makes a longer O. In Quebec you'll need this word. Knowing it correctly helps in emergencies!",diff:1},
      {type:"match",prompt:"Match each letter to how it sounds in French",pairs:[["E","uh (like the)"],["É","ay (like say)"],["R","guttural throat"],["H","always silent"],["OU","oo (like moon)"]],explain:"These 5 sound rules unlock French pronunciation completely. Once you know them you can read ANY French word out loud!",diff:2},
      {type:"fill",before:"The French letter H is always",blank:"___",after:"— you never say it out loud.",options:["silent","loud","guttural","nasal"],correct:0,explain:"H is ALWAYS silent in French — no exceptions! hôpital = oh-pee-tal, homme = omm, heure = ur. This is one of the most common mistakes English speakers make. Now you know!",diff:1},
      {type:"mcq",prompt:"How do you say 'bonjour' correctly?",options:["BON-joor","bon-ZHOOR","BON-jour","bohn-JUR"],correct:1,explain:"bon-ZHOOR! The J makes a 'zh' sound (like the s in measure). The R is guttural — from the back of your throat. The most important word in French — say it right!",diff:2},
      {type:"mcq",prompt:"The French U sound (like in 'tu' = you) is made by:",options:["Saying oo normally","Rounding lips for oo then saying ee","Saying you fast","Opening mouth wide"],correct:1,explain:"French U is unique — it doesn't exist in English! Round your lips tight for oo then try to say ee. The tension between them IS the French U. Tu, rue, lune. Practice this and you'll impress every Quebecker!",diff:3},
      {type:"scene",story:"Priya calls the hospital (hôpital) in Montreal. The receptionist answers in French. Priya needs to say she has an appointment (rendez-vous).",prompt:"How does Priya pronounce 'hôpital'?",options:["HOH-pee-tal","oh-pee-TAL","hoh-SPEE-tal","hoh-pee-TAL"],correct:1,explain:"oh-pee-TAL — H is silent, ô makes a long O. In emergencies, pronouncing it correctly helps the person understand you immediately. This lesson could literally save your life!",diff:2},
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
      {type:"order",prompt:"Say the price: twenty-five dollars",words:["vingt","et","cinq","dollars"],answer:["vingt","cinq","dollars"],explain:"Vingt-cinq dollars! Note: 21, 31, 41... use 'et un' (vingt et un). But 22-29 just hyphenate: vingt-deux, vingt-cinq. No 'et' for 22-29!",diff:3},
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
];

  mkL("a2-16","Comparative & Superlative",25,"writing",
    "How do you say something is better, worse, bigger, or the best in French? Comparatives and superlatives are essential for job interviews, apartment hunting, and everyday conversation. Today you master these structures so you can confidently compare salaries, neighbourhoods, candidates, and more in professional French.",
    ["plus...que = more...than","moins...que = less...than","aussi...que = as...as","meilleur(e) = better (adjective)","mieux = better (adverb)","le/la/les plus = the most","le/la/les moins = the least","pire = worse","le pire = the worst","autant que = as much as"],
    [mcq("How do you say 'Montreal is bigger than Quebec City'?",["Montréal est grand que Québec","Montréal est plus grand que Québec","Montréal est le plus grand Québec","Montréal est aussi grand Québec"],1,"Plus + adjective + que = more...than. Montréal est plus grand que Québec = Montreal is bigger than Quebec City. This structure works for any adjective: plus cher, plus loin, plus difficile!",1),
     mcq("'Ce quartier est moins cher que Plateau-Mont-Royal.' What does this mean?",["This neighbourhood is more expensive than Plateau-Mont-Royal","This neighbourhood is as expensive as Plateau-Mont-Royal","This neighbourhood is less expensive than Plateau-Mont-Royal","This neighbourhood is the cheapest"],2,"Moins + adjective + que = less...than. Moins cher = less expensive. Perfect for comparing apartments, neighbourhoods, and prices in Quebec!",1),
     {type:"match",prompt:"Match the comparative to its meaning",pairs:[["plus grand que","bigger than"],["moins cher que","less expensive than"],["aussi bon que","as good as"],["meilleur que","better than"],["le plus rapide","the fastest"]],explain:"These 5 comparison structures cover 90% of comparisons you'll make in French. Master them and you can compare jobs, apartments, schools, and anything else in professional conversations!",diff:2},
     {type:"fill",before:"Ce salaire est",blank:"___",after:"que mon ancien poste. (This salary is better than my old position.)",options:["meilleur","plus bon","mieux","plus meilleur"],correct:0,explain:"Meilleur = better (adjective, modifying a noun like salaire). Mieux = better (adverb, modifying a verb). Meilleur salaire, meilleure offre — always use meilleur as an adjective!",diff:2},
     mcq("How do you say 'This is the best French course in Canada'?",["C'est le plus bon cours de français au Canada","C'est le meilleur cours de français au Canada","C'est le mieux cours de français au Canada","C'est le plus meilleur cours"],1,"Le meilleur = the best (superlative of bon). Never say 'le plus bon' — meilleur already contains the comparison. C'est le meilleur restaurant, le meilleur hôpital, le meilleur quartier!",2),
     {type:"scene",story:"Priya is comparing two job offers with her mentor. She says: 'Le premier poste offre un meilleur salaire, mais le deuxième est plus proche de chez moi et les avantages sociaux sont aussi bons.'",prompt:"What is Priya comparing?",options:["Salary, location, and benefits of two job offers","Two apartments she wants to rent","Two French courses she is considering","Two schools for her children"],correct:0,explain:"Meilleur salaire = better salary. Plus proche = closer (location). Aussi bons = equally good (benefits). Priya is doing a professional comparison of two job offers — using all three comparison structures perfectly!",diff:3},
     {type:"order",prompt:"Build: This neighbourhood is less expensive than downtown",words:["Ce","quartier","est","moins","cher","que","le","centre-ville"],answer:["Ce","quartier","est","moins","cher","que","le","centre-ville"],explain:"Ce quartier est moins cher que le centre-ville — perfect comparative! Moins + adjective + que. This sentence will save you thousands of dollars when apartment hunting in Montreal!",diff:2},
     wr("Write a sentence comparing two things in your life using a comparative",["plus","moins","aussi","meilleur","que"],"Excellent use of comparatives! Being able to compare options in French is crucial for negotiations — salary, rent, job offers. Practice one comparison every day!",2)]),

  mkL("a2-17","Transportation & Getting Around",20,"speaking",
    "Quebec has excellent public transit — the STM metro in Montreal, the RTC in Quebec City, the Exo commuter trains. But navigating it in French requires specific vocabulary. Today you learn to buy tickets, ask for directions, understand schedules, and get where you need to go confidently. This lesson is practical from day one.",
    ["le métro = subway/metro","l'autobus = the bus","la ligne = the line (metro/bus)","l'arrêt = the stop","la correspondance = the transfer","un aller simple = one way ticket","un aller-retour = return ticket","la prochaine station = the next station","Où dois-je descendre? = Where should I get off?","Quel bus va à...? = Which bus goes to...?"],
    [mcq("You need to transfer lines at Berri-UQAM metro station. What do you ask?",["Où est l'autobus?","Où est la correspondance pour la ligne verte?","Je voudrais un aller-retour","Quelle est la prochaine station?"],1,"La correspondance = the transfer point. Pour la ligne verte = for the green line. This is the exact question you ask at Berri-UQAM, the main transfer hub in Montreal's metro system!",1),
     mcq("The bus driver says 'Prochain arrêt: Place des Arts'. What does this mean?",["Last stop: Place des Arts","Next stop: Place des Arts","Transfer at Place des Arts","Closed station: Place des Arts"],1,"Prochain = next. Arrêt = stop. You'll hear this announcement on every Montreal STM bus! Place des Arts is a major stop — this phrase helps you know when to get ready to exit.",1),
     {type:"match",prompt:"Match the transit term to its meaning",pairs:[["un aller simple","one way ticket"],["la correspondance","the transfer"],["l'arrêt","the stop"],["la ligne","the line"],["Où dois-je descendre?","Where should I get off?"]],explain:"These 5 terms are essential for navigating Quebec's excellent public transit system. The STM metro in Montreal and RTC buses in Quebec City — all announcements are in French!",diff:1},
     {type:"fill",before:"Excusez-moi, quel métro va",blank:"___",after:"l'aéroport Trudeau?",options:["à","pour","vers","en"],correct:0,explain:"Quel métro va à = which metro goes to. À is used before specific destinations. In Montreal, you'd take the orange line to Lionel-Groulx then the 204 or 209 bus to the airport!",diff:2},
     mcq("You want to ask the bus driver where to get off for the RAMQ office. You say:",["RAMQ s'il vous plaît","Pouvez-vous me dire où descendre pour la RAMQ?","Arrêtez ici pour la RAMQ","Je veux aller RAMQ"],1,"Pouvez-vous me dire où descendre pour...? = Can you tell me where to get off for...? This polite question works on any bus or metro in Quebec. Drivers are helpful — don't hesitate to ask!",2),
     {type:"scene",story:"Ravi just arrived in Montreal and needs to get from the airport to downtown. He approaches the info desk and asks in French. The agent says 'Prenez le bus 204 jusqu'à Lionel-Groulx, puis la ligne orange direction Côte-Vertu ou Montmorency.'",prompt:"What should Ravi do?",options:["Take bus 204 to Lionel-Groulx, then the orange line","Take the orange line directly from the airport","Take a taxi to downtown","Walk to the nearest metro station"],correct:0,explain:"Prenez le bus 204 jusqu'à = take bus 204 to. Puis = then. La ligne orange = the orange metro line. This is the actual route from Trudeau airport! Ravi understood real French transit directions — great achievement!",diff:2},
     {type:"order",prompt:"Ask: Which bus goes to the Sainte-Justine hospital?",words:["Quel","autobus","va","à","l'hôpital","Sainte-Justine?"],answer:["Quel","autobus","va","à","l'hôpital","Sainte-Justine?"],explain:"Quel autobus va à...? — the most useful transit question in Quebec! Works for any destination: hospital, school, government office, shopping centre. Master this phrase and you can navigate any Quebec city.",diff:1},
     wr("Write how you would ask which metro line goes to Old Montreal",["quelle ligne","quel métro","va à","le Vieux-Montréal","pour aller à"],"Quelle ligne de métro va au Vieux-Montréal? — In Montreal, take the orange line to Champ-de-Mars! Being able to ask transit questions in French means you can explore every corner of Quebec independently.",2)]),

  mkL("a2-18","Relative Clauses — qui, que, où",25,"writing",
    "French relative clauses connect ideas elegantly. Without them, you sound choppy and basic. With them, you sound fluent and professional. Qui (subject), que (object), où (place/time) — three small words that transform your French. Today you master these so you can describe people, places, and things with sophistication.",
    ["qui = who/which (subject of the clause)","que/qu' = whom/which (object of the clause)","où = where/when (place or time)","La femme qui travaille ici = The woman who works here","Le poste que j'ai accepté = The job that I accepted","La ville où j'habite = The city where I live","C'est quelqu'un qui... = It's someone who...","C'est quelque chose que... = It's something that...","Le jour où = The day when","Ce qui me plaît = What I like (subject)"],
    [mcq("Choose the correct relative pronoun: 'La personne ___ m'a aidé parle français.'",["que","qui","où","dont"],1,"Qui = subject of the relative clause. La personne qui m'a aidé = The person who helped me. Qui replaces the subject of the clause. Ask yourself: who is doing the action? That person/thing uses QUI!",1),
     mcq("Choose the correct pronoun: 'Le cours ___ j'ai suivi était excellent.'",["qui","où","que","dont"],2,"Que/qu' = object of the relative clause. Le cours que j'ai suivi = The course that I took. J'ai suivi le cours → le cours que j'ai suivi. Que replaces the object. Ask: what is receiving the action? → QUE!",1),
     {type:"match",prompt:"Match the sentence to the relative pronoun used",pairs:[["La ville où je suis né","où (place)"],["Le médecin qui m'a soigné","qui (subject)"],["Le formulaire que j'ai rempli","que (object)"],["Le jour où j'ai trouvé du travail","où (time)"],["L'ami qui parle trois langues","qui (subject)"]],explain:"Qui = subject (doing the action). Que = object (receiving the action). Où = place or time. These three words are the foundation of fluent French speech — use them and you sound educated and professional!",diff:2},
     {type:"fill",before:"C'est le quartier",blank:"___",after:"j'habite depuis mon arrivée au Canada.",options:["où","qui","que","qu'"],correct:0,explain:"Où = where (place). C'est le quartier où j'habite = It's the neighbourhood where I live. Où is used for locations and times — le quartier où, la ville où, le jour où, l'époque où.",diff:2},
     mcq("Which sentence is grammatically correct?",["C'est un emploi que correspond à mes compétences","C'est un emploi qui correspond à mes compétences","C'est un emploi où correspond à mes compétences","C'est un emploi dont correspond à mes compétences"],1,"Qui correspond = which corresponds (subject). L'emploi does the corresponding, so it's the subject → QUI. C'est un emploi qui correspond à mes compétences = It's a job that matches my skills. Perfect for job interviews!",2),
     {type:"scene",story:"Sara writes in her cover letter: 'Je suis une professionnelle qui maîtrise le français et l'anglais. Le poste que vous offrez correspond exactement au profil que j'ai développé pendant cinq ans. La ville où vous êtes situés est également idéale pour ma famille.'",prompt:"How many relative pronouns does Sara use correctly?",options:["3 (qui, que, où — all correct)","2 (qui and que only)","1 (only qui)","None are used correctly"],correct:0,explain:"Sara uses all three: qui (subject — she masters languages), que (object — the position that you offer, the profile that I developed), où (place — the city where you're located). Three relative pronouns in one cover letter — that's C1 level writing! This is how you impress Quebec employers.",diff:3},
     {type:"order",prompt:"Build: The company where I work offers good benefits",words:["La","compagnie","où","je","travaille","offre","de","bons","avantages"],answer:["La","compagnie","où","je","travaille","offre","de","bons","avantages"],explain:"La compagnie où je travaille offre de bons avantages — using où for place. This elegant sentence shows you can connect clauses naturally. Much better than two choppy sentences!",diff:2},
     wr("Write two sentences connecting them with qui, que, or où",["qui","que","où","c'est","le","la","les"],"Connecting sentences with relative pronouns is the mark of an educated French speaker. Practice building one complex sentence daily — your French will sound dramatically more sophisticated within weeks!",3)]),

  mkL("a2-19","Shopping & Consumer French",20,"speaking",
    "Quebec's shops, malls, and markets are all in French. From asking about sizes to returning a defective product, understanding receipts to comparing prices — today you learn the complete French of Quebec retail. Whether you're at IGA, Canadian Tire, or the Jean Talon market, you'll navigate every shopping situation with confidence.",
    ["la caisse = the checkout/cashier","un reçu = a receipt","échanger = to exchange","rembourser = to refund","la politique de retour = return policy","C'est en solde = It's on sale","Avez-vous une plus grande taille? = Do you have a bigger size?","C'est trop cher = It's too expensive","Je cherche... = I'm looking for...","Ça coûte combien? = How much does it cost?"],
    [mcq("You bought shoes that are too small. You say:",["Je voudrais rembourser ces chaussures","Je voudrais échanger ces chaussures pour une plus grande taille","Ces chaussures sont défectueuses","Je n'aime pas ces chaussures"],1,"Échanger = to exchange. Je voudrais échanger pour une plus grande taille = I'd like to exchange for a bigger size. Always bring your reçu (receipt) — most Quebec stores require it for exchanges within 30 days!",1),
     mcq("The store sign says 'Soldes — jusqu'à 50%'. What does this mean?",["Sold out — up to 50%","Sales — up to 50% off","Sold — minimum 50 items","Special — only 50 available"],1,"Soldes = sales/discounts. Jusqu'à 50% = up to 50% off. You'll see this during Quebec's big sale seasons: Boxing Day, spring/summer clearance, and back-to-school. C'est en solde = it's on sale!",1),
     {type:"match",prompt:"Match the shopping phrase to its meaning",pairs:[["la caisse","the checkout"],["un reçu","a receipt"],["rembourser","to refund"],["la politique de retour","return policy"],["en solde","on sale"]],explain:"These 5 terms are essential for confident shopping in Quebec. Knowing them means you can navigate any store, handle returns professionally, and never get confused at the checkout!",diff:1},
     {type:"fill",before:"Excusez-moi, est-ce que vous avez ce chandail en",blank:"___",after:"plus grande?",options:["taille","pointure","grandeur","mesure"],correct:0,explain:"La taille = clothing size. Avez-vous ce chandail en taille plus grande? = Do you have this sweater in a larger size? Note: chandail = sweater (Quebec French!). For shoes, use pointure instead of taille.",diff:2},
     mcq("Your receipt shows 'TPS: $2.50, TVQ: $4.98'. What are these?",["Tips for the cashier","Federal and provincial taxes","Total price and sale price","Store credit and discount"],1,"TPS = Taxe sur les Produits et Services (federal GST = 5%). TVQ = Taxe de vente du Québec (provincial QST = 9.975%). In Quebec, prices shown are before tax — always add ~15% mentally!",2),
     {type:"scene",story:"Amara buys a coat at La Baie for $189.99. At the caisse, the cashier asks 'Avez-vous notre carte de fidélité?' and then 'C'est tout pour vous aujourd'hui?'",prompt:"What is the cashier asking?",options:["Do you have our loyalty card? and Is that everything for you today?","Do you have a coupon? and Do you want a bag?","Is this your size? and Do you want to pay by card?","Is the coat on sale? and Do you need a receipt?"],correct:0,explain:"Carte de fidélité = loyalty/rewards card. C'est tout pour vous = is that everything for you. These are the two most common cashier questions in Quebec stores. Answer: 'Non merci' for the card if you don't have one, and 'Oui c'est tout, merci!'",diff:2},
     {type:"order",prompt:"Say: I would like to return this item, I have the receipt",words:["Je","voudrais","retourner","cet","article,","j'ai","le","reçu"],answer:["Je","voudrais","retourner","cet","article,","j'ai","le","reçu"],explain:"Je voudrais retourner cet article, j'ai le reçu — polite, clear, and complete. This exact sentence works at any Quebec store for returns. Keep your receipts for 30 days — most stores require them!",diff:1},
     wr("Write how you would ask a store clerk to help you find something",["je cherche","pouvez-vous m'aider","où est","avez-vous","je voudrais trouver"],"Excusez-moi, je cherche... pouvez-vous m'aider? — This polite request gets you assistance in any Quebec store immediately. Store clerks in Quebec are required to serve you in French — it's your right!",1)]),

  mkL("a2-20","Talking About Your Home Country",20,"speaking",
    "Quebecers are curious about immigrants' backgrounds — where you're from, what life was like, why you came to Canada. These conversations happen constantly: with neighbours, coworkers, at your child's school. Today you learn to talk about your home country, your journey to Canada, and your adaptation with confidence and warmth.",
    ["mon pays d'origine = my country of origin","avant d'arriver au Canada = before arriving in Canada","je suis originaire de = I am originally from","la culture = culture","les coutumes = customs","la langue maternelle = mother tongue","s'adapter à = to adapt to","le dépaysement = culture shock / feeling of displacement","la nostalgie = nostalgia","la communauté = the community"],
    [mcq("Someone asks 'D'où êtes-vous originaire?' How do you respond?",["Je suis à Montréal","Je suis originaire de l'Inde — je viens de Mumbai","Je parle hindi","Je suis arrivé en janvier"],1,"Je suis originaire de + pays = I am originally from + country. D'où êtes-vous originaire? = Where are you originally from? This is the polite, formal version. In casual conversation: D'où venez-vous / t'es d'où?",1),
     mcq("How do you say 'Before arriving in Canada, I worked as an engineer for 10 years'?",["Je travaille ingénieur 10 ans avant","Avant d'arriver au Canada, j'ai travaillé comme ingénieur pendant 10 ans","Je suis ingénieur avant Canada","Avant Canada je travaillais ingénieur 10 ans"],1,"Avant d'arriver au Canada = before arriving in Canada (infinitive construction). J'ai travaillé comme = I worked as. Pendant 10 ans = for 10 years. This sentence is perfect for introducing your professional background!",1),
     {type:"match",prompt:"Match the immigration experience word to its meaning",pairs:[["mon pays d'origine","my home country"],["la langue maternelle","mother tongue"],["s'adapter à","to adapt to"],["le dépaysement","culture shock"],["la communauté","the community"]],explain:"These 5 words describe the immigrant experience perfectly. Quebecers appreciate when immigrants can articulate their journey — it builds genuine human connection and shows cultural intelligence.",diff:1},
     {type:"fill",before:"J'ai dû",blank:"___",after:"à la culture québécoise, mais les gens sont très accueillants.",options:["m'adapter","m'adapte","m'adaptant","adapter"],correct:0,explain:"S'adapter à = to adapt to (reflexive verb). J'ai dû m'adapter = I had to adapt. This honest and positive statement resonates deeply with Quebecers — showing that you've embraced the challenge of adaptation.",diff:2},
     mcq("Your neighbour asks about life in your home country. The best response begins with:",["Non je ne veux pas parler","Avant d'arriver au Canada, la vie était très différente mais riche en culture...","Le Canada est mieux","Mon pays est pauvre"],1,"Avant d'arriver au Canada, la vie était très différente mais riche en culture = Before arriving in Canada, life was very different but rich in culture. This warm, open response builds connection. Never compare countries negatively — Quebecers appreciate cultural curiosity!",2),
     {type:"scene",story:"At a neighbour's BBQ, someone asks Priya: 'Comment tu trouves la vie au Québec comparée à l'Inde?' She responds: 'C'est très différent mais j'aime beaucoup la qualité de vie ici. Ce qui me manque, c'est la cuisine de ma mère et ma famille, mais la communauté indienne à Montréal est très active!'",prompt:"What does Priya share that makes her response excellent?",options:["She compares positively, shares what she misses, and mentions community — balanced and warm","She only talks about what she misses from India","She says Canada is better than India","She avoids talking about India"],correct:0,explain:"Priya's response is perfect: positive comparison (j'aime beaucoup la qualité de vie), honest about nostalgia (ce qui me manque), and community-connected (communauté indienne active). This is exactly how to discuss your immigrant experience warmly in Quebec!",diff:2},
     {type:"order",prompt:"Share: I am originally from India and I arrived in Canada three years ago",words:["Je","suis","originaire","de","l'Inde","et","je","suis","arrivé","au","Canada","il","y","a","trois","ans"],answer:["Je","suis","originaire","de","l'Inde","et","je","suis","arrivé","au","Canada","il","y","a","trois","ans"],explain:"Je suis originaire de l'Inde et je suis arrivé au Canada il y a trois ans — a natural, complete introduction. Il y a trois ans = three years ago (il y a + duration). Practice saying this fluently — you'll use it constantly!",diff:2},
     wr("Write 2-3 sentences about what you love about Canada and what you miss from home",["j'aime","ce qui me manque","la qualité de vie","ma famille","cependant","mais","la culture"],"Sharing your immigrant story in French is powerful. Quebecers deeply respect immigrants who have embraced their new home while honoring their roots. This authenticity builds real friendships.",2)]),

  mkL("a2-21","Indirect Speech — Reporting What Was Said",25,"writing",
    "He said, she told me, they announced — indirect speech is how we report conversations and news. It's essential for workplace communication, understanding the news, and telling stories. French indirect speech requires specific tense changes. Today you master this crucial skill for professional and social communication.",
    ["Il a dit que... = He said that...","Elle m'a demandé si... = She asked me if...","Ils ont annoncé que... = They announced that...","Direct → Indirect tense changes:","présent → imparfait","passé composé → plus-que-parfait","futur → conditionnel","Il a dit: 'Je pars' → Il a dit qu'il partait","Elle a demandé: 'Es-tu prêt?' → Elle a demandé si j'étais prêt","Dire que, annoncer que, expliquer que, demander si"],
    [mcq("'Je suis fatigué' becomes indirect speech: 'Il a dit qu'il...'",["est fatigué","était fatigué","sera fatigué","serait fatigué"],1,"Indirect speech: présent (est) → imparfait (était). Il a dit qu'il était fatigué = He said he was tired. This tense shift is automatic in French indirect speech — present always becomes imperfect!",1),
     mcq("Direct: 'Je viendrai demain.' Indirect: 'Elle a dit qu'elle...'",["vient demain","venait demain","viendrait le lendemain","viendra demain"],2,"Indirect speech: futur (viendrai) → conditionnel (viendrait). Also: demain → le lendemain (time expressions shift!). Elle a dit qu'elle viendrait le lendemain = She said she would come the next day.",2),
     {type:"match",prompt:"Match direct speech to indirect speech",pairs:[["'Je travaille ici'","Il a dit qu'il travaillait là"],["'Est-ce que tu veux?'","Elle a demandé si je voulais"],["'Nous partirons'","Ils ont dit qu'ils partiraient"],["'J'ai fini'","Il a dit qu'il avait fini"],["'Viens!'","Elle m'a demandé de venir"]],explain:"Four key patterns: présent→imparfait, futur→conditionnel, PC→PQP, and imperatives become infinitives. Note how time and place words change too (ici→là, demain→le lendemain). This is advanced French that impresses employers!",diff:3},
     {type:"fill",before:"Mon patron m'a dit que la réunion",blank:"___",after:"annulée. (My boss told me the meeting was cancelled.)",options:["était","est","sera","serait"],correct:0,explain:"Indirect speech: est → était (présent → imparfait). Mon patron m'a dit que la réunion était annulée = My boss told me the meeting was cancelled. You'll hear this at work constantly — knowing indirect speech means you can relay information accurately!",diff:2},
     mcq("Your colleague says 'Le directeur a annoncé qu'il y aurait une augmentation.' What did the director announce?",["There will be no raise","There would be a raise","There was a raise already","He needs a raise"],1,"Il y aurait = there would be (conditionnel of il y a). Futur → conditionnel in indirect speech. Le directeur a annoncé qu'il y aurait une augmentation = The director announced there would be a raise. Excellent workplace French!",2),
     {type:"scene",story:"Ravi tells his wife: 'Au travail aujourd'hui, mon patron m'a dit que j'avais fait du bon travail et qu'il voulait me donner plus de responsabilités. Il a aussi demandé si j'étais intéressé par une formation.'",prompt:"What did Ravi's boss communicate (using indirect speech)?",options:["Boss said Ravi did good work, wants to give more responsibility, asked about training interest","Boss gave Ravi a raise","Boss wants Ravi to leave","Boss asked Ravi to work overtime"],correct:0,explain:"Three pieces of indirect speech: j'avais fait du bon travail (PC→PQP), il voulait me donner (présent→imparfait), si j'étais intéressé (direct question→indirect with si). Ravi is using perfect indirect speech to tell his story!",diff:3},
     {type:"order",prompt:"Report: She told me that the office would be closed tomorrow",words:["Elle","m'a","dit","que","le","bureau","serait","fermé","le","lendemain"],answer:["Elle","m'a","dit","que","le","bureau","serait","fermé","le","lendemain"],explain:"Elle m'a dit que le bureau serait fermé le lendemain — futur (sera) becomes conditionnel (serait), demain becomes le lendemain. This is professional communication in French — relaying information accurately. Essential for the workplace!",diff:3},
     wr("Report what someone said to you recently using indirect speech",["il/elle a dit que","m'a demandé si","a annoncé que","était","aurait","voulait"],"Using indirect speech correctly is a mark of genuine French fluency. When you can accurately relay conversations, you can participate fully in Quebec professional and social life. Practice daily!",3)]),

  mkL("a2-22","The Subjunctive — When Feelings Matter",30,"writing",
    "The subjunctive is the tense that separates intermediate from advanced French. It's used after expressions of emotion, doubt, necessity, and desire. In Quebec professional writing and formal speech, the subjunctive is essential. Today you learn the most important subjunctive triggers and how to form this crucial tense.",
    ["Il faut que + subjonctif = It's necessary that","Je veux que = I want (someone) to","Je voudrais que = I would like (someone) to","Il est important que = It's important that","Bien que = Although (always + subjonctif)","Pour que = So that (always + subjonctif)","À condition que = On the condition that","Que vous parliez = that you speak (subjonctif)","Que nous puissions = that we can (subjonctif)","Que j'aie = that I have (subjonctif of avoir)"],
    [mcq("Which sentence correctly uses the subjunctive?",["Il faut que tu sais parler français","Il faut que tu saches parler français","Il faut que tu sait parler français","Il faut que tu savoir parler français"],1,"Il faut que + subjonctif! Savoir → que tu saches. The subjunctive of savoir is irregular: que je sache, que tu saches. Il faut que tu saches parler français = You need to know how to speak French. This sentence will motivate you!",1),
     mcq("'Bien que' always requires which tense?",["indicatif","futur","subjonctif","conditionnel"],2,"Bien que = although — ALWAYS followed by subjonctif. Bien que je sois fatigué = Although I am tired. Bien que le chemin soit difficile = Although the path is difficult. Memorize this: bien que → subjonctif, automatically!",1),
     {type:"match",prompt:"Match the trigger to whether it requires subjunctive",pairs:[["Il faut que","subjonctif"],["Je pense que","indicatif"],["Pour que","subjonctif"],["Parce que","indicatif"],["Bien que","subjonctif"]],explain:"Key rule: verbs of certainty/fact (penser que, croire que, savoir que) use indicatif. Expressions of necessity, desire, doubt, emotion, and concession (il faut que, bien que, pour que) use subjonctif. Learn these triggers!",diff:2},
     {type:"fill",before:"Il est essentiel que vous",blank:"___",after:"votre demande avant le 30 avril. (It's essential that you submit your application before April 30.)",options:["soumettiez","soumettez","soumettrez","soumettre"],correct:0,explain:"Il est essentiel que + subjonctif. Soumettre → que vous soumettiez (subjonctif). This sentence appears in many official Quebec government letters! Recognizing the subjunctive in official communications helps you understand your legal obligations.",diff:3},
     mcq("'Je voudrais que vous ___ ce formulaire.' What form of remplir goes here?",["remplissez","remplirez","remplissiez","remplir"],2,"Je voudrais que + subjonctif. Remplir → que vous remplissiez (subjonctif). Note: different from the indicatif (vous remplissez) and futur (vous remplirez). Je voudrais que vous remplissiez = I would like you to fill out. Very polite and professional!",2),
     {type:"scene",story:"In a formal letter to her employer, Sara writes: 'Je vous écris pour que vous puissiez prendre une décision informée. Il est important que cette demande soit traitée rapidement, bien que je comprenne que vous soyez très occupé.'",prompt:"How many subjunctive forms does Sara correctly use?",options:["3 (puissiez, soit, soyez — all correct)","1 (only puissiez)","2 (puissiez and soit)","None — she made errors"],correct:0,explain:"Sara uses 3 perfect subjunctives: pour que vous puissiez (so that you can), il est important que la demande soit traitée (be processed), bien que vous soyez occupé (although you are busy). This is C1 level professional writing! This letter would impress any Quebec employer.",diff:3},
     {type:"order",prompt:"Build: It's important that you know your rights in Quebec",words:["Il","est","important","que","vous","connaissiez","vos","droits","au","Québec"],answer:["Il","est","important","que","vous","connaissiez","vos","droits","au","Québec"],explain:"Il est important que + connaissiez (subjonctif of connaître). Connaître: que vous connaissiez. This sentence is empowering — knowing your rights in Quebec and being able to express this need in French puts you in control of your life in Canada.",diff:3},
     wr("Write a sentence using 'il faut que' or 'bien que' with the subjunctive",["il faut que","bien que","pour que","il est important que","subjonctif"],"Using the subjunctive correctly is the mark of genuine advanced French. It appears in formal letters, legal documents, and professional communications. Master it and you unlock the full power of written French!",3)]),

  mkL("a2-23","Telephoning in French",25,"speaking",
    "Calling a doctor, a government office, your child's school, an employer — phone calls in French are stressful for many immigrants. You can't see the person's face, can't read lips, and must respond quickly. Today you learn the complete French of phone calls: answering, asking to speak to someone, leaving messages, and dealing with common phone situations.",
    ["Allô = Hello (on phone in Quebec)","C'est ___ à l'appareil = ___ speaking","Je voudrais parler à... = I would like to speak to...","Est-ce que je peux laisser un message? = Can I leave a message?","Pouvez-vous répéter plus lentement? = Can you repeat more slowly?","Je vous rappellerai = I will call you back","Vous avez fait un faux numéro = You have the wrong number","Ne quittez pas = Hold on / Don't hang up","Quel est votre numéro de rappel? = What is your callback number?","Je vous entends mal = I can hear you poorly"],
    [mcq("You call a doctor's office. The receptionist says 'Bureau du Dr Tremblay, bonjour!' How do you respond?",["Allô oui","Bonjour, c'est ___ à l'appareil. Je voudrais prendre un rendez-vous.","Je veux docteur","Parlez-vous anglais?"],1,"Bonjour, c'est ___ à l'appareil = Hello, this is ___ speaking. Then state your purpose. Always give your name first — it's standard professional phone etiquette in Quebec. The receptionist will immediately know you're organized and professional!",1),
     mcq("You don't understand what the caller said. You say:",["Quoi?","Pardon? Pouvez-vous répéter plus lentement s'il vous plaît?","Je ne comprends pas le français","Parlez anglais"],1,"Pouvez-vous répéter plus lentement? = Can you repeat more slowly? This is the perfect, polite way to ask for clarification on the phone. Every French speaker understands this and will slow down for you. Never be embarrassed to ask!",1),
     {type:"match",prompt:"Match the phone phrase to its meaning",pairs:[["Ne quittez pas","Hold on please"],["Vous avez fait un faux numéro","Wrong number"],["Je vous rappellerai","I'll call you back"],["À l'appareil","Speaking (on the phone)"],["Quel est votre numéro de rappel?","What's your callback number?"]],explain:"These 5 phrases cover 80% of phone situations in French. Ne quittez pas (hold), faux numéro (wrong number), je rappellerai (callback), à l'appareil (speaking), numéro de rappel (callback number) — memorize these and phone calls become manageable!",diff:1},
     {type:"fill",before:"Bonjour, je voudrais",blank:"___",after:"un message pour Madame Côté s'il vous plaît.",options:["laisser","donner","faire","mettre"],correct:0,explain:"Laisser un message = to leave a message. Je voudrais laisser un message = I would like to leave a message. This is the standard phrase when the person you're calling isn't available. Always leave your name and number clearly!",diff:2},
     mcq("The automated message says 'Pour le service en français, appuyez sur le 1.' What should you do?",["Hang up","Press 1 for French service","Wait for an operator","Call back later"],1,"Appuyez sur le 1 = press 1. Pour le service en français = for French service. Many Canadian phone systems offer French and English options. Always press 1 for French — it's your right in Quebec, and services are better in your chosen language!",2),
     {type:"scene",story:"Amara calls Service Canada. An automated message plays: 'Bienvenue à Service Canada. Pour le français, appuyez sur le 1. Pour l'anglais, appuyez sur le 2.' Then a person answers: 'Service Canada, bonjour!' Amara needs to ask about her employment insurance application.",prompt:"What should Amara say after the agent greets her?",options:["Bonjour, c'est Amara à l'appareil. Je voudrais des informations sur ma demande d'assurance-emploi.","Parlez-vous anglais?","Est-ce que Service Canada est ouvert?","Je veux l'assurance emploi"],correct:0,explain:"Perfect phone opening: give your name (c'est Amara à l'appareil), then state your purpose clearly (ma demande d'assurance-emploi). This professional approach gets results faster — the agent knows exactly what you need and can pull up your file immediately.",diff:2},
     {type:"order",prompt:"Leave a message: My name is Ravi, please call me back at 514-555-0123",words:["Je","m'appelle","Ravi,","pouvez-vous","me","rappeler","au","514-555-0123","s'il","vous","plaît?"],answer:["Je","m'appelle","Ravi,","pouvez-vous","me","rappeler","au","514-555-0123","s'il","vous","plaît?"],explain:"Je m'appelle Ravi, pouvez-vous me rappeler au 514-555-0123 s'il vous plaît? — a complete, professional phone message. Always say your name first, then the callback number. In Quebec, phone numbers are said in groups: cinq-quatorze, cinq-cinq-cinq, zéro-un-deux-trois.",diff:2},
     wr("Write what you would say when calling to make a doctor's appointment in French",["bonjour","je voudrais","rendez-vous","c'est","à l'appareil","docteur","prendre"],"Bonjour, c'est ___ à l'appareil. Je voudrais prendre un rendez-vous avec le docteur ___ s'il vous plaît. — Mastering this call means you can manage your health in French. In Quebec, even scheduling a doctor's appointment is done in French!",2)]),

  mkL("a2-24","Reading French News & Media",25,"reading",
    "Le Journal de Montréal, Radio-Canada, La Presse — Quebec's French media keeps you connected to your new home. Reading and understanding French news develops your vocabulary, connects you to Quebec society, and prepares you for CLB reading tests. Today you learn how to read French news articles efficiently and understand media language.",
    ["selon = according to","d'après = according to (more informal)","a déclaré = declared/stated","affirme = affirms/says","les autorités = the authorities","une conférence de presse = a press conference","le gouvernement provincial = the provincial government","le taux de chômage = the unemployment rate","une hausse = an increase","une baisse = a decrease"],
    [mcq("A news headline reads 'Hausse du salaire minimum au Québec'. What happened?",["The minimum wage decreased in Quebec","The minimum wage increased in Quebec","The minimum wage stayed the same","The minimum wage was abolished"],1,"Hausse = increase/rise. Hausse du salaire minimum = increase in minimum wage. The opposite is baisse (decrease). You'll see hausse and baisse constantly in Quebec economic news — vital vocabulary for understanding your financial rights!",1),
     mcq("The article says 'Selon le premier ministre, la situation s'améliore.' What does 'selon' mean?",["Despite","Because of","According to","Until"],2,"Selon = according to. Selon le premier ministre = according to the Premier. French journalism always attributes statements — selon, d'après, a déclaré, affirme. This helps you evaluate who is saying what in news articles.",1),
     {type:"match",prompt:"Match the news vocabulary to its meaning",pairs:[["une conférence de presse","a press conference"],["le taux de chômage","the unemployment rate"],["les autorités","the authorities"],["a déclaré","declared / stated"],["une baisse","a decrease"]],explain:"These 5 news vocabulary words appear in every Quebec news article. Knowing them means you can read La Presse or watch Radio-Canada and follow current events in your new home — essential for integration and CLB reading tests!",diff:1},
     {type:"fill",before:"Le gouvernement provincial a annoncé une",blank:"___",after:"des impôts pour les familles à faible revenu.",options:["baisse","hausse","augmentation","réduction"],correct:0,explain:"Baisse = decrease/reduction. Baisse des impôts = tax reduction. Une réduction would also work here! Knowing this vocabulary means you understand when the government announces changes that affect your family's finances directly.",diff:2},
     mcq("The headline says 'Le taux de chômage atteint un nouveau creux au Québec'. What does this mean?",["Unemployment reached a new high","Unemployment reached a new low","Unemployment is unchanged","Unemployment is unmeasurable"],1,"Un creux = a low/trough (opposite of un sommet = a high). Atteint = reaches/hits. Le taux de chômage atteint un nouveau creux = Unemployment hits a new low. Good economic news for Quebec! This means more jobs available — relevant to your job search.",2),
     {type:"scene",story:"Priya reads this Radio-Canada article: 'Le gouvernement Legault a annoncé mercredi une nouvelle politique d'immigration. Selon le ministre, la province accueillera 60 000 nouveaux résidents permanents cette année. D'après les experts consultés, cette décision aura un impact positif sur l'économie québécoise.'",prompt:"What are the three pieces of information in this article?",options:["New immigration policy announced; 60,000 permanent residents this year; positive economic impact expected","Election results; new tax policy; unemployment statistics","Housing shortage; healthcare crisis; education reform","Border closures; refugee crisis; economic recession"],correct:0,explain:"Perfect news reading! The article: (1) announces a new immigration policy, (2) gives the number (60,000 permanent residents), and (3) includes expert opinion (positive economic impact). Priya read and understood a real Radio-Canada news structure — she's ready for Quebec society!",diff:2},
     {type:"order",prompt:"Build: According to the minister, the unemployment rate decreased this year",words:["Selon","le","ministre,","le","taux","de","chômage","a","baissé","cette","année"],answer:["Selon","le","ministre,","le","taux","de","chômage","a","baissé","cette","année"],explain:"Selon le ministre, le taux de chômage a baissé cette année — perfect news sentence structure! Attribution (selon) + subject + verb in passé composé. This is exactly how Radio-Canada and La Presse report economic news. Reading French news every day is one of the best ways to improve your French!",diff:2},
     wr("Summarize one piece of news you heard recently in French",["selon","le gouvernement","a annoncé","il y a eu","une hausse","une baisse","les autorités"],"Writing news summaries in French is excellent CLB exam practice! The reading and writing sections of CLB/TEF tests use exactly this type of news vocabulary. Start reading Radio-Canada.ca daily — 10 minutes a day transforms your comprehension!",2)]),

  mkL("a2-25","Feelings & Mental Health Vocabulary",20,"mixed",
    "Talking about your feelings, stress, and mental health in French is important for your wellbeing in Canada. Whether explaining to a doctor that you're anxious, telling a friend you're stressed about work, or understanding mental health resources, this vocabulary matters deeply. Today you learn to express emotions and access support with dignity.",
    ["je me sens = I feel","le stress = stress","l'anxiété = anxiety","déprimé(e) = depressed","épuisé(e) = exhausted","soutien = support","un psychologue = a psychologist","un travailleur social = a social worker","Ça va mieux = I'm doing better","Prendre soin de soi = to take care of oneself"],
    [mcq("You tell your doctor you've been feeling very stressed. You say:",["Je suis très stress","Je me sens très stressé(e) ces derniers temps","Le stress moi","J'ai le stress beaucoup"],1,"Je me sens + adjective = I feel. Très stressé(e) = very stressed. Ces derniers temps = lately/recently. This complete sentence gives your doctor exactly the information needed. Always add a time reference — depuis quand (since when) helps with diagnosis!",1),
     mcq("Your friend says 'Je suis complètement épuisé(e)'. What do they mean?",["I'm very hungry","I'm completely exhausted","I'm totally bored","I'm very busy"],1,"Épuisé(e) = exhausted/burnt out. Complètement = completely. You'll hear this a lot in Quebec — it's an intense word for extreme tiredness. Quebec has high rates of burnout (épuisement professionnel) — knowing this word helps you recognize when colleagues or friends need support.",1),
     {type:"match",prompt:"Match the mental health word to its meaning",pairs:[["le soutien","support"],["déprimé(e)","depressed"],["l'anxiété","anxiety"],["un travailleur social","a social worker"],["prendre soin de soi","to take care of oneself"]],explain:"These 5 mental health terms are essential for accessing healthcare in Quebec. CLSC social workers (travailleurs sociaux) provide free mental health support to all Quebec residents. Knowing this vocabulary means you can ask for and access the help you deserve.",diff:1},
     {type:"fill",before:"Depuis mon arrivée au Canada, je",blank:"___",after:"parfois anxieux/anxieuse à cause du changement.",options:["me sens","suis senti","sens","me sente"],correct:0,explain:"Je me sens = I feel (reflexive verb). Je me sens anxieux/anxieuse = I feel anxious. This honest statement is important — many immigrants experience anxiety during settlement. Quebec's healthcare system has free resources for this. You deserve support!",diff:2},
     mcq("You want to find mental health support in Quebec. You should call:",["911","Le CLSC de votre quartier — ils offrent du soutien psychologique gratuit","Votre employeur","Le gouvernement fédéral"],1,"Le CLSC (Centre Local de Services Communautaires) offers free psychological support and social work services to all Quebec residents! CLSCs are located in every neighbourhood. No referral needed for many services — just call your local CLSC.",2),
     {type:"scene",story:"Amara tells her doctor: 'Docteur, je me sens très fatiguée et stressée depuis trois mois. J'ai du mal à dormir et je me sens parfois déprimée. Est-ce qu'il y a du soutien disponible?'",prompt:"What did Amara communicate effectively?",options:["Duration of symptoms (3 months), specific symptoms (tired, stressed, poor sleep, depressed), and asked for support","She asked for medication only","She said she was fine","She only mentioned tiredness"],correct:0,explain:"Amara communicated perfectly: duration (depuis trois mois), three symptoms (fatiguée, stressée, mal à dormir, déprimée), and asked for support (soutien disponible). This complete description helps her doctor provide the best care. You have the RIGHT to healthcare in French in Quebec!",diff:2},
     {type:"order",prompt:"Say: I would like to speak with a social worker about my stress",words:["Je","voudrais","parler","avec","un","travailleur","social","concernant","mon","stress"],answer:["Je","voudrais","parler","avec","un","travailleur","social","concernant","mon","stress"],explain:"Je voudrais parler avec un travailleur social concernant mon stress — this sentence opens doors to free mental health support in Quebec. Concernant = concerning/regarding. CLSCs provide this service free to all residents. Asking for help is strength, not weakness.",diff:2},
     wr("Write how you would describe your current stress level and what causes it in French",["je me sens","stressé","à cause de","le travail","la famille","depuis","j'ai du mal à"],"Expressing your mental health needs in French ensures you get appropriate support in Quebec. The healthcare system is designed to help — but you need to communicate clearly. Practice these phrases so they're ready when you need them most.",2)]),
];

  mkL("a2-26","The Passive Voice",25,"writing",
    "The passive voice is everywhere in formal French — in news articles, government documents, workplace communications. 'The application was rejected', 'The law was passed', 'The meeting was cancelled' — all passive. Today you master how to recognize and use the passive voice, transforming your reading of official documents and professional writing.",
    ["Passif = être + participe passé","La demande a été refusée = The application was rejected","Le formulaire doit être rempli = The form must be filled out","La loi a été adoptée = The law was passed","Être + pp changes with subject gender","Active: Le médecin signe le formulaire","Passive: Le formulaire est signé par le médecin","Par = by (agent in passive)","On peut also replace passive in spoken French","La réunion a été annulée = The meeting was cancelled"],
    [mcq("Make this sentence passive: 'Le gouvernement a approuvé la demande.'",["La demande approuvée par le gouvernement","La demande a été approuvée par le gouvernement","La demande était approuvée le gouvernement","La demande approuve le gouvernement"],1,"Active → Passive: sujet + avoir/être + pp → objet + être + pp + par + sujet. La demande a été approuvée par le gouvernement = The application was approved by the government. This structure appears in every official Quebec government letter!",2),
     mcq("A letter says 'Votre dossier sera examiné dans les 30 jours.' What will happen?",["Your file must be submitted in 30 days","Your file will be examined within 30 days","Your file was examined 30 days ago","Your file is being examined now"],1,"Sera examiné = will be examined (futur passif: sera + participé passé). Dans les 30 jours = within 30 days. This sentence appears in letters from RAMQ, SAAQ, and Service Canada. You will receive this — now you understand it!",1),
     {type:"match",prompt:"Match the passive sentence to its meaning",pairs:[["La réunion a été annulée","The meeting was cancelled"],["Le contrat sera signé demain","The contract will be signed tomorrow"],["Le formulaire doit être rempli","The form must be filled out"],["Les résultats ont été publiés","The results were published"],["La décision a été prise","The decision was made"]],explain:"These 5 passive sentences appear constantly in Quebec professional life. Government letters, workplace emails, news articles — the passive voice is unavoidable. Recognizing it means you understand your rights and obligations correctly!",diff:2},
     {type:"fill",before:"Votre candidature",blank:"___",after:"examinée par notre comité de sélection. (Your application will be examined by our selection committee.)",options:["sera","est","a été","serait"],correct:0,explain:"Sera examinée = will be examined (futur passif). Note: examinée agrees with candidature (feminine). In job applications, you'll receive letters like this — now you understand exactly what will happen to your application!",diff:2},
     mcq("'On parle français ici' and 'Le français est parlé ici' mean:",["Something different","Exactly the same thing","The first is wrong","The second is more formal but both mean French is spoken here"],3,"On + active verb = informal passive substitute. On parle français = French is spoken. Le français est parlé = French is spoken (formal passive). Both are correct — the passive voice is more formal. Government documents use passive; everyday conversation uses on.",2),
     {type:"scene",story:"Ravi receives a letter from Immigration, Réfugiés et Citoyenneté Canada: 'Votre demande a été reçue le 15 mars. Elle sera traitée dans les 12 mois suivants. Une décision vous sera communiquée par courrier. Des documents supplémentaires pourraient être demandés.'",prompt:"What does this letter tell Ravi about his application?",options:["Application received March 15; processing takes up to 12 months; decision by mail; additional documents may be requested","Application rejected; must reapply; go to office; pay fees","Application approved; interview scheduled; documents ready; card coming","Application lost; nothing received; must call; no decision yet"],correct:0,explain:"Four passive sentences perfectly understood: a été reçue (was received), sera traitée (will be processed), vous sera communiquée (will be communicated to you), pourraient être demandés (could be requested). Ravi now fully understands his immigration letter — that's transformative!",diff:3},
     {type:"order",prompt:"Build: The decision was made by the committee yesterday",words:["La","décision","a","été","prise","par","le","comité","hier"],answer:["La","décision","a","été","prise","par","le","comité","hier"],explain:"La décision a été prise par le comité hier — passive voice: être (a été) + participé passé (prise, feminine to agree with décision) + par + agent. Mastering this structure means you can write and understand formal French at a professional level!",diff:3},
     wr("Write one passive sentence about something that happened to you or in the news",["a été","sera","est","par","le gouvernement","la décision","a été approuvé"],"Using the passive voice in writing shows C1 level sophistication. Government correspondence, legal documents, and professional reports all use passive constructions. Recognizing them is essential for navigating Canadian bureaucracy confidently.",3)]),

  mkL("a2-27","Housing — Finding & Renting an Apartment",25,"mixed",
    "Finding housing in Quebec is challenging — competitive markets, French-only listings, landlord interviews, the unique July 1st moving day. Today you learn everything you need to find and secure housing in French: reading listings, contacting landlords, visiting apartments, and understanding your rights as a tenant under Quebec's Régie du logement.",
    ["une annonce = a listing/advertisement","le/la propriétaire = the landlord","le locataire = the tenant","la visite = the viewing/visit","un bail = a lease","les charges incluses = utilities included","le dépôt = deposit (note: illegal in Quebec!)","la Régie du logement = Quebec housing tribunal","animaux acceptés = pets allowed","disponible le 1er juillet = available July 1st"],
    [mcq("A Quebec apartment listing says 'Loyer: 1100$/mois, eau chaude incluse, animaux acceptés, dispo 1er juil.' What does this mean?",["$1100/month, cold water included, no pets, available July 1","$1100/month, hot water included, pets allowed, available July 1","$1100/month, all utilities included, pets negotiable, available June 1","$1000/month, no utilities, no pets, available July 1"],1,"Eau chaude incluse = hot water included. Animaux acceptés = pets allowed. Dispo = disponible. 1er juil = July 1st — Quebec's universal moving day! Understanding listings saves you time and money when apartment hunting.",1),
     mcq("A landlord asks for a dépôt de garantie (security deposit). What should you know?",["Security deposits are required by Quebec law","Security deposits are illegal in Quebec — landlords cannot legally request them","Security deposits are optional","Security deposits must equal one month's rent"],1,"Security deposits are ILLEGAL in Quebec! The Régie du logement prohibits them. If a landlord asks for a deposit beyond the first month's rent, you can refuse. This is one of Quebec's strongest tenant protections — know your rights!",2),
     {type:"match",prompt:"Match the housing term to its meaning",pairs:[["les charges incluses","utilities included"],["un bail","a lease"],["la Régie du logement","Quebec housing tribunal"],["animaux acceptés","pets allowed"],["disponible le 1er juillet","available July 1st"]],explain:"These 5 housing terms are essential for apartment hunting in Quebec. The Régie du logement is the body that protects tenant rights — it's free to use and very powerful. Know it exists!",diff:1},
     {type:"fill",before:"Je vous écris concernant votre annonce pour l'appartement",blank:"___",after:"au 3ème étage. Serait-il possible de faire une visite?",options:["disponible","loué","vendu","occupé"],correct:0,explain:"Disponible = available. Je vous écris concernant l'appartement disponible = I'm writing about the available apartment. This is the opening line of a professional apartment inquiry email. Add your availability: Je serais disponible [jours et heures].",diff:1},
     mcq("Your landlord wants to increase your rent. Under Quebec law they must:",["Give you 3 months notice before April 1st","Give you 24 hours notice","Increase rent anytime","Get court approval first"],0,"Quebec law requires landlords to give written notice of rent increases 3 months before the lease renewal date (for yearly leases). The notice must arrive before April 1st for July 1st renewals. You have the right to refuse — the Régie du logement will decide!",3),
     {type:"scene",story:"Ravi visits an apartment. The landlord says: 'L'appartement fait 4½, chauffage et eau chaude inclus. Le loyer est de 1250$ par mois. Le bail commence le 1er juillet pour 12 mois. Il n'y a pas d'animaux et pas de fumeurs.'",prompt:"What did Ravi learn about this apartment?",options:["4.5 rooms, heat and hot water included, $1250/month, July 1st 12-month lease, no pets, no smoking","3 rooms, electricity included, $1250/week, June 1st, pets ok, smoking ok","5 rooms, no utilities, $1250 bi-weekly, July 15th, pets allowed","4 rooms, cold water only, $1250 one time, August 1st, no restrictions"],correct:0,explain:"In Quebec, 4½ = 4.5 rooms (living room, kitchen, 2 bedrooms + bathroom). Chauffage = heating. The landlord gave complete lease information. Ravi now understands a complete French apartment description — he can make an informed decision!",diff:2},
     {type:"order",prompt:"Ask: Is it possible to visit the apartment this Saturday?",words:["Serait-il","possible","de","visiter","l'appartement","ce","samedi?"],answer:["Serait-il","possible","de","visiter","l'appartement","ce","samedi?"],explain:"Serait-il possible de + infinitif? = Would it be possible to? The conditionnel makes this very polite. This is the perfect apartment visit request — professional, respectful, and likely to get a positive response from Quebec landlords.",diff:2},
     wr("Write an email requesting to view an apartment you found in a listing",["je vous écris","concernant","l'appartement","disponible","je serais disponible","serait-il possible","visite"],"A well-written apartment inquiry email in French dramatically increases your chances of getting a viewing in competitive Quebec rental markets. Landlords prefer tenants who communicate professionally — your French skills give you an advantage!",2)]),

  mkL("a2-28","Discussing Plans & Intentions",20,"speaking",
    "Talking about your plans, goals, and intentions is central to social and professional life. Job interviews ask about your 5-year plan. Neighbours ask what you're doing this weekend. Friends ask about your dreams for Canada. Today you master three key structures for expressing plans: aller + infinitif, avoir l'intention de, and envisager de.",
    ["aller + infinitif = going to (near future)","avoir l'intention de = to intend to","envisager de = to plan/consider (more formal)","compter + infinitif = to plan to","espérer + infinitif = to hope to","je pense + infinitif = I think I'll","dans ce cas = in that case","à long terme = in the long term","à court terme = in the short term","mes objectifs = my goals/objectives"],
    [mcq("How do you say 'I'm going to apply for Canadian citizenship next year'?",["Je vais appliquer pour la citoyenneté canadienne l'année prochaine","Je vais à appliquer pour la citoyenneté","J'applique pour la citoyenneté l'année prochaine","Je ferai applique pour la citoyenneté"],0,"Aller + infinitif = going to (near future). Je vais + appliquer = I'm going to apply. This is the most common way to talk about near-future plans in French. No preposition between aller and the infinitive!",1),
     mcq("In a job interview: 'Quelles sont vos intentions professionnelles à long terme?' is asking:",["What are your hobbies?","What are your long-term professional goals?","What was your last job?","What languages do you speak?"],1,"Intentions professionnelles = professional intentions/goals. À long terme = in the long term. This is a standard job interview question in Quebec. Answer with: J'ai l'intention de / J'envisage de / À long terme, je compte...",1),
     {type:"match",prompt:"Match the intention phrase to its formality level",pairs:[["je vais + infinitif","informal, everyday"],["avoir l'intention de","neutral, common"],["envisager de","formal, professional"],["compter + infinitif","neutral, spoken"],["espérer + infinitif","hopeful, optimistic"]],explain:"These 5 structures all express future plans but at different levels. Use je vais with friends, avoir l'intention de in general conversation, and envisager de in job interviews and formal contexts. Choosing the right register shows language sophistication!",diff:2},
     {type:"fill",before:"J'envisage",blank:"___",after:"ouvrir ma propre entreprise dans cinq ans.",options:["de","à","pour","d'"],correct:0,explain:"Envisager de + infinitif = to plan to / to consider. J'envisage d'ouvrir = I'm planning to open (d' before vowel). This ambitious statement in a job interview shows entrepreneurial spirit. Always follow it with 'mais pour l'instant, je veux contribuer à votre entreprise.'",diff:2},
     mcq("Your interviewer asks 'Où vous voyez-vous dans 5 ans?' The best response starts with:",["Je ne sais pas","À long terme, j'ai l'intention de progresser dans mon domaine et d'assumer plus de responsabilités...","Je veux être votre patron","Dans 5 ans je serai riche"],1,"À long terme, j'ai l'intention de = In the long term, I intend to. This professional opening shows ambition and planning. Add specifics: progresser dans mon domaine (advance in my field), assumer des responsabilités (take on responsibilities), contribuer à la croissance (contribute to growth).",2),
     {type:"scene",story:"During his annual review, Ravi's manager asks about his career plans. Ravi responds: 'À court terme, j'ai l'intention de perfectionner mon français professionnel et d'obtenir ma certification. À long terme, j'envisage de gérer une équipe et de contribuer au développement de nouveaux projets. J'espère également poursuivre des formations continues.'",prompt:"How many different intention structures does Ravi use?",options:["3 (avoir l'intention de, envisager de, espérer)","1 (only avoir l'intention de)","2 (avoir l'intention and envisager)","None — he just describes what he wants"],correct:0,explain:"Ravi perfectly uses 3 structures: j'ai l'intention de (I intend to), j'envisage de (I plan to), j'espère (I hope). He also organizes by timeline: à court terme / à long terme. This answer would impress any Quebec manager — sophisticated, organized, and ambitious!",diff:2},
     {type:"order",prompt:"Say your intention: I plan to get my driving licence before winter",words:["J'ai","l'intention","d'obtenir","mon","permis","de","conduire","avant","l'hiver"],answer:["J'ai","l'intention","d'obtenir","mon","permis","de","conduire","avant","l'hiver"],explain:"J'ai l'intention d'obtenir mon permis de conduire avant l'hiver — a practical and important goal for life in Quebec! Winters can make driving essential. This complete sentence with timeline shows organized thinking in French.",diff:2},
     wr("Write 2-3 sentences about your plans for life in Canada using different intention structures",["j'ai l'intention de","je vais","j'envisage de","j'espère","à court terme","à long terme","compter"],"Planning your future in French is empowering! Using varied intention structures (aller, avoir l'intention de, envisager de, espérer) shows language sophistication. Write these goals down and revisit them — your French and your life in Canada will both progress!",2)]),

  mkL("a2-29","Numbers — Advanced: Dates, Times, Money",20,"mixed",
    "Numbers in French go beyond counting. Dates, times, large sums, percentages, temperatures — Quebec life requires numerical fluency in French. Reading a pay stub, filling tax forms, understanding your mortgage, discussing temperatures in a Quebec winter (-30°C!) — today you master the French of numbers in real contexts.",
    ["le vingt et un juin = June 21st","deux mille vingt-six = 2026","soixante-quinze pour cent = 75%","moins trente degrés = -30 degrees","un million deux cent mille = 1,200,000","une virgule cinq = 1.5 (decimals use comma!)","le premier = the 1st (ordinal for dates)","mille = 1,000","un milliard = one billion","environ / à peu près = approximately"],
    [mcq("How do you say the date April 19, 2026 in French?",["Dix-neuf avril deux mille vingt-six","Avril dix-neuf deux mille vingt-six","Le dix-neuf d'avril, deux mille vingt-six","Nineteen-April-twenty-twenty-six"],2,"Date format: le + jour (cardinal, except 1st=premier) + de + mois + , + année. Le dix-neuf avril, deux mille vingt-six. Note: in French dates, day comes BEFORE month, and no 'of' is needed in formal writing (just le 19 avril 2026).",1),
     mcq("Your utility bill shows 'Montant dû: 2 345,67$'. How do you read this in French?",["Two thousand three hundred forty-five point sixty-seven dollars","Deux mille trois cent quarante-cinq virgule soixante-sept dollars","Two three four five sixty-seven dollars","Deux trois quatre cinq dollars"],1,"French decimals use virgule (comma), not point. 2 345,67 = deux mille trois cent quarante-cinq virgule soixante-sept. Large numbers use space as thousands separator in French (not comma like English). This is on every Quebec bill!",2),
     {type:"match",prompt:"Match the number expression to its meaning",pairs:[["soixante-quinze pour cent","75%"],["moins vingt degrés","-20°C"],["deux virgule cinq","2.5"],["un million","1,000,000"],["le premier mai","May 1st"]],explain:"These 5 numerical expressions are essential for daily Quebec life. Percentages (pour cent) on your pay stub, temperatures in winter forecasts (-20°C!), decimals on bills (virgule not point), and dates — numerical French is everywhere!",diff:1},
     {type:"fill",before:"Le loyer est de mille deux",blank:"___",after:"dollars par mois.",options:["cent cinquante","cent","cents","centaine"],correct:0,explain:"Deux cents = two hundred (note: no 's' on cent when followed by another number: deux cent cinquante = 250, but deux cents = 200). Mille deux cent cinquante = 1,250. This is essential for discussing rent, salary, and prices in Quebec!",diff:2},
     mcq("The weather forecast says 'Il fera moins trente degrés ce week-end'. What should you do?",["Go to the beach","Stay warm — it will be -30°C this weekend!","Open the windows — it's 30°C","Plan outdoor activities"],1,"Moins trente degrés = -30°C. Quebec winters are famous for extreme cold — temperatures can reach -40°C with wind chill! Dress in layers: manteau d'hiver (winter coat), tuque (winter hat), mitaines (mittens), bottes d'hiver (winter boots). This is real Quebec life!",2),
     {type:"scene",story:"Ravi reads his first Canadian tax return notice: 'Revenu total: 52 400$. Impôt fédéral: 7 860$. Impôt provincial: 9 432$. Remboursement: 1 245,50$. Date limite: le 30 avril 2026.'",prompt:"What are the key numbers Ravi needs to understand?",options:["Total income $52,400; federal tax $7,860; provincial tax $9,432; refund $1,245.50; deadline April 30 2026","No important numbers — it's just paperwork","Only the refund amount matters","Only the deadline matters"],correct:0,explain:"Tax returns are full of critical numbers! Ravi correctly identifies: revenu total (total income), impôt fédéral (federal tax), impôt provincial (provincial tax), remboursement (refund — good news!), and date limite (deadline). Understanding these numbers correctly means money in your pocket!",diff:2},
     {type:"order",prompt:"Say: The temperature this winter reached minus forty degrees",words:["La","température","cet","hiver","a","atteint","moins","quarante","degrés"],answer:["La","température","cet","hiver","a","atteint","moins","quarante","degrés"],explain:"La température cet hiver a atteint moins quarante degrés — a sentence every Quebec resident has said! Atteint = reached (from atteindre). Moins quarante = -40°C. Quebec winters are legendary — but with the right vocabulary (and clothing!), you'll embrace them like a true Quebecer.",diff:2},
     wr("Write your current address in French with your postal code, written out in words",["rue","appartement","Montréal","Québec","code postal","le","au"],"Writing your address and numbers correctly in French is essential for all official documents in Quebec — tax returns, RAMQ forms, driver's licence applications. Practice your complete address until you can write and say it automatically!",1)]),

  mkL("a2-30","Work Vocabulary — Your Workplace Rights",25,"mixed",
    "You have important rights as a worker in Quebec — minimum wage, overtime, vacation, parental leave, workplace safety. But you can only exercise these rights if you know the vocabulary. Today you learn the essential French of Quebec labour rights so you can advocate for yourself, understand your pay stub, and know when your rights are being violated.",
    ["la CNESST = Quebec labour standards commission","le salaire minimum = minimum wage","les heures supplémentaires = overtime","le congé parental = parental leave","les vacances annuelles = annual vacation","le syndicat = the union","un congé de maladie = sick leave","le harcèlement = harassment","une plainte = a complaint","les normes du travail = labour standards"],
    [mcq("Your employer hasn't paid your overtime. You should contact:",["La police","La CNESST (Commission des normes, de l'équité, de la santé et de la sécurité du travail)","Service Canada","RAMQ"],1,"La CNESST is Quebec's labour standards commission. It's free to use and protects all Quebec workers, including immigrants. They handle: unpaid wages, overtime violations, discrimination, harassment, and unsafe working conditions. You have these rights from your first day of work in Quebec!",2),
     mcq("Your pay stub shows 'heures supplémentaires: 6h à 1.5x'. What does this mean?",["6 hours of regular work","6 hours of overtime paid at 1.5 times your regular rate","6 hours deducted from your pay","6 hours of sick leave"],1,"Heures supplémentaires = overtime. À 1.5x = at 1.5 times the rate (time and a half). In Quebec, hours over 40/week must be paid at 1.5x. This is the law — check your pay stub every time!",1),
     {type:"match",prompt:"Match the labour rights term to its meaning",pairs:[["le congé parental","parental leave"],["les normes du travail","labour standards"],["le harcèlement","harassment"],["une plainte","a complaint"],["le syndicat","the union"]],explain:"These 5 labour rights terms protect you as a worker in Quebec. Parental leave (congé parental) is 52-97 weeks in Quebec — one of the best in North America! Knowing these terms means you can claim what is legally yours.",diff:1},
     {type:"fill",before:"En vertu des normes du travail du Québec, tout travailleur a droit à",blank:"___",after:"semaines de vacances après un an de service.",options:["deux","une","cinq","dix"],correct:0,explain:"Two weeks vacation = deux semaines de vacances after one year of service in Quebec. After 3 years: 3 weeks. After 10 years: 4 weeks minimum. En vertu de = by virtue of / under. This is the law — you MUST receive paid vacation!",2),
     mcq("Your colleague says 'Je vais déposer une plainte à la CNESST.' What are they going to do?",["File a police report","Resign from their job","File a complaint with Quebec's labour commission","Apply for employment insurance"],2,"Déposer une plainte = to file a complaint. À la CNESST = with Quebec's labour standards commission. This is a legal right — you can file complaints about unpaid wages, discrimination, unsafe conditions, and harassment. It's FREE and confidential for workers.",2),
     {type:"scene",story:"Sara discovers her employer hasn't paid her overtime for 3 months. She reads on CNESST.gouv.qc.ca: 'Tout salarié au Québec a droit à une majoration de 50% pour les heures effectuées au-delà de 40 heures par semaine. La plainte doit être déposée dans les 3 ans suivant la violation.'",prompt:"What did Sara learn about her rights?",options:["She has the right to 50% overtime for hours over 40/week, and has 3 years to file a complaint","She must accept what her employer decides","She needs a lawyer before filing anything","Overtime rights only apply to full-time workers"],correct:0,explain:"Majoration de 50% = 50% increase (time and a half). Au-delà de 40 heures = beyond 40 hours. Doit être déposée dans les 3 ans = must be filed within 3 years. Sara knows her rights and the deadline — she can now act! This is why French vocabulary is power in Canada.",diff:3},
     {type:"order",prompt:"Assert your right: I have the right to two weeks of paid vacation",words:["J'ai","droit","à","deux","semaines","de","vacances","payées"],answer:["J'ai","droit","à","deux","semaines","de","vacances","payées"],explain:"J'ai droit à deux semaines de vacances payées — saying this confidently to your employer is your legal right in Quebec! J'ai droit à = I have the right to. This phrase opens every labour rights conversation. Say it clearly, know it's true, and exercise it!",diff:1},
     wr("Write a sentence about one workplace right you have in Quebec that is important to you",["j'ai droit à","les normes du travail","le congé","les heures supplémentaires","la CNESST","en vertu de"],"Knowing your workplace rights in French is literally worth money. Unclaimed overtime, missed vacation pay, unlawful deductions — these cost Quebec workers millions every year. Your French knowledge is your protection. When in doubt, consult CNESST.gouv.qc.ca — free and in French!",2)]),

  mkL("a2-31","Pronoms — Direct & Indirect Objects",25,"writing",
    "Object pronouns replace nouns to avoid repetition. 'I sent the form to the office' becomes 'I sent it to them.' In French, getting these pronouns right is essential for natural-sounding speech and formal writing. Today you master direct and indirect object pronouns — the key to truly fluent French.",
    ["me/m' = me (direct or indirect)","te/t' = you (direct or indirect)","le/la/l' = him/her/it (direct only)","lui = him/her (indirect only)","nous = us (direct or indirect)","vous = you (direct or indirect)","les = them (direct only)","leur = them (indirect only)","Position: BEFORE the verb in French","Je le vois = I see him/it"],
    [mcq("'Je vois Marie tous les jours.' Replace Marie with a pronoun:",["Je la vois tous les jours","Je lui vois tous les jours","Je le vois tous les jours","Je les vois tous les jours"],0,"Marie is a direct object (I see her — no preposition). Feminine direct object pronoun = la. Je la vois tous les jours = I see her every day. La/le/les go before the verb!",1),
     mcq("'J'écris à mon patron.' Replace 'à mon patron' with a pronoun:",["Je le lui écris","Je l'écris","Je lui écris","Je les écris"],2,"À + person = indirect object → lui. J'écris à mon patron → Je lui écris. Lui replaces à + masculine or feminine singular person. Je lui écris = I write to him/her. Note: lui is BOTH masculine and feminine for indirect objects!",1),
     {type:"match",prompt:"Replace the underlined word with the correct pronoun",pairs:[["Je vois [le médecin]","Je le vois"],["Je parle [à ma sœur]","Je lui parle"],["Il envoie [les formulaires]","Il les envoie"],["Elle téléphone [aux parents]","Elle leur téléphone"],["Nous aidons [toi]","Nous t'aidons"]],explain:"Direct objects (no preposition before person/thing): le/la/les. Indirect objects (à + person): lui/leur. This distinction is the key to correct object pronouns. Master it and your French will sound dramatically more natural!",diff:2},
     {type:"fill",before:"J'ai envoyé le dossier au bureau. Je",blank:"___",after:"ai envoyé hier. (I sent it yesterday.)",options:["l'","lui","le","la"],correct:0,explain:"Dossier = masculine noun → direct object pronoun = le → l' (before vowel). Je l'ai envoyé = I sent it. In passé composé, pronoun goes before the auxiliary (ai). Je l'ai envoyé = I sent it. The past participle agrees: envoyé stays masculine!",diff:2},
     mcq("Which sentence correctly uses TWO object pronouns?",["Je le lui ai donné","Je lui le ai donné","Je l'ai lui donné","Je lui ai donné le"],0,"Je le lui ai donné = I gave it to him/her. Double pronoun order: direct (le) BEFORE indirect (lui). The order is: me/te/se/nous/vous → le/la/les → lui/leur → y → en. Je le lui ai donné is the only correct order!",3),
     {type:"scene",story:"Amara's supervisor asks her to send the monthly report to the clients. She replies: 'Je le leur envoie cet après-midi.' Later she tells her colleague: 'Je leur ai envoyé ce matin, et je leur ai aussi expliqué les nouvelles procédures.'",prompt:"What do the pronouns refer to in Amara's replies?",options:["Le = the report (direct object); leur = the clients (indirect object); her French is perfect","Le = the clients; leur = the report; she made errors","Both pronouns refer to the report","Amara made grammatical errors"],correct:0,explain:"Je le leur envoie: le = le rapport (direct object, masculine), leur = aux clients (indirect object, plural). Je leur ai envoyé and je leur ai expliqué: leur = aux clients. Amara uses double object pronouns correctly — this is advanced French! She's communicating like a native professional.",diff:3},
     {type:"order",prompt:"Replace: I gave the documents to my colleague → I gave them to her",words:["Je","les","lui","ai","donnés"],answer:["Je","les","lui","ai","donnés"],explain:"Je les lui ai donnés — double pronoun! Les (les documents, direct) + lui (à ma collègue, indirect). Note: les documents is plural AND the past participle donnés agrees with les (plural masculine). Advanced French — you're achieving real mastery!",diff:3},
     wr("Replace the nouns with pronouns in this sentence: 'J'envoie les formulaires à mon employeur'",["je les","lui","leur","le","la","l'","objet direct","objet indirect"],"Je les lui envoie — perfect! Object pronouns make your French flow naturally without repetition. In professional writing and formal speech, using pronouns correctly is a mark of true language mastery. Practice with sentences from your daily life!",3)]),

  mkL("a2-32","Quebec Culture & Social Customs",20,"mixed",
    "Understanding Quebec culture makes daily life easier and more fulfilling. From the province's unique French-Canadian identity to social customs, holidays, food culture, and the famous Quebec sense of humour — today you learn the cultural knowledge that turns you from a newcomer into someone who truly belongs. Quebec has a rich, distinct culture and Quebecers love sharing it.",
    ["la Saint-Jean-Baptiste = Quebec's national holiday (June 24)","le Carnaval de Québec = Quebec Winter Carnival (February)","le Jour de l'An = New Year's Day (big celebration in Quebec!)","la poutine = iconic Quebec dish (fries, curds, gravy)","le sirop d'érable = maple syrup","les sucres = sugar shack (spring tradition)","le temps des fêtes = the holiday season","dépanneur = convenience store (uniquely Quebec)","le souper = dinner (Quebec often uses souper not dîner)","avoir du fun = to have fun (Quebec English-French mix)"],
    [mcq("June 24th in Quebec is:",["Canada Day","Quebec's national holiday — La Fête Nationale / Saint-Jean-Baptiste","French Language Day","Moving Day"],1,"La Fête Nationale du Québec (also called Saint-Jean-Baptiste) on June 24th is Quebec's most important cultural holiday. Concerts, fireworks, and celebrations across the province! It's a day of pride in Quebec's French culture — join the celebrations in your neighbourhood.",1),
     mcq("A Quebecer invites you to 'les sucres'. What is this?",["A dentist appointment","A traditional spring visit to a sugar shack where maple syrup is made","A grocery shopping trip","A formal dinner"],1,"Les sucres = a sugar shack visit! Every spring (March-April), Quebec families visit érablières (maple farms) to watch maple syrup being made, eat traditional dishes (oreilles de crisse, tire sur la neige), and celebrate the end of winter. It's a beloved Quebec tradition — say yes if invited!",1),
     {type:"match",prompt:"Match the Quebec cultural term to its meaning",pairs:[["la poutine","fries with cheese curds and gravy"],["le dépanneur","convenience store"],["le temps des fêtes","the holiday season"],["avoir du fun","to have fun"],["le souper","dinner (supper)"]],explain:"These 5 cultural terms are part of everyday Quebec life. Using them correctly shows you've embraced Quebec culture. Quebecers love when immigrants use these terms — it signals belonging and respect for their distinct culture.",diff:1},
     {type:"fill",before:"Ce soir, on va au",blank:"___",after:"chercher de la bière et des chips. (Tonight we're going to the convenience store for beer and chips.)",options:["dépanneur","supermarché","pharmacie","restaurant"],correct:0,explain:"Le dépanneur (or 'le dép') = convenience store — a uniquely Quebec institution! Open late, sells beer (in Quebec only — not in other provinces!), snacks, lottery tickets. Every neighbourhood has one. Using this word instantly marks you as someone who knows Quebec culture.",diff:1},
     mcq("During 'le temps des fêtes', what is most important for Quebec families?",["Going to work","Gathering with family, exchanging gifts, eating traditional foods like tourtière and bûche de Noël","Going to the beach","Shopping sales"],1,"Le temps des fêtes (Christmas-New Year period) is the most important family time in Quebec. Tourtière (meat pie), bûche de Noël (Christmas log cake), réveillon (Christmas Eve dinner), and Jour de l'An celebrations. Quebec takes its holidays seriously — and joyfully!",2),
     {type:"scene",story:"At work, Ravi's Quebecer colleagues invite him: 'Ce samedi, on organise une cabane à sucre! Tu viens? On va manger de la tire sur la neige, de la soupe aux pois, et du jambon. C'est une tradition québécoise incontournable!'",prompt:"What tradition are they sharing with Ravi?",options:["A sugar shack visit — a Quebec spring tradition with maple syrup, pea soup, and ham","A winter carnival","A moving day party","A summer BBQ"],correct:0,explain:"Cabane à sucre = sugar shack! Tire sur la neige = taffy on snow (melted maple syrup poured on snow, then rolled on a stick). Soupe aux pois = pea soup. Jambon = ham. These are traditional Quebec sugar shack dishes. This invitation is a privilege — Ravi is being welcomed into Quebec culture!",diff:2},
     {type:"order",prompt:"Express excitement: I love Quebec culture, especially maple syrup season!",words:["J'adore","la","culture","québécoise,","surtout","le","temps","des","sucres!"],answer:["J'adore","la","culture","québécoise,","surtout","le","temps","des","sucres!"],explain:"J'adore la culture québécoise, surtout le temps des sucres! — Expressing genuine appreciation for Quebec culture opens doors and hearts. Surtout = especially. Quebecers deeply appreciate when immigrants embrace their unique cultural identity. Say this and mean it!",diff:1},
     wr("Write about one Quebec tradition or cultural element you have experienced or want to experience",["j'aime","j'ai participé à","je voudrais découvrir","la culture québécoise","c'est","une tradition","surtout"],"Connecting with Quebec culture through French is one of the most powerful ways to build belonging in your new home. Whether it's sugar shack season, Saint-Jean-Baptiste celebrations, or just calling the convenience store 'le dép' — every cultural connection deepens your roots.",2)]),

  mkL("a2-33","Giving Directions in French",20,"speaking",
    "Getting and giving directions in French is essential for daily life in Quebec. Whether you're helping a lost tourist, following a colleague's instructions to a meeting location, or understanding GPS in French, today's lesson makes you navigationally fluent. Quebec's street system has specific vocabulary and Quebec City's old-town streets require special precision.",
    ["tournez à gauche = turn left","tournez à droite = turn right","allez tout droit = go straight","prenez la rue = take the street","au coin de = at the corner of","en face de = across from","à côté de = next to","à deux rues d'ici = two blocks from here","le carrefour = the intersection","continuez jusqu'à = continue until"],
    [mcq("Someone asks how to get to the metro. You say:",["Là-bas","Tournez à gauche au coin de la rue, puis allez tout droit jusqu'au métro.","Je ne sais pas","Prenez un taxi"],1,"Tournez à gauche = turn left. Au coin de la rue = at the corner of the street. Allez tout droit = go straight. Jusqu'au métro = until the metro. This complete direction uses all key direction vocabulary — clear and helpful!",1),
     mcq("'La pharmacie est en face de l'hôtel de ville.' Where is the pharmacy?",["Next to city hall","Behind city hall","Across from city hall","Inside city hall"],2,"En face de = across from / opposite. La pharmacie est en face de l'hôtel de ville = The pharmacy is across from city hall. En face de is one of the most useful location phrases in French — used constantly for giving addresses and meeting points.",1),
     {type:"match",prompt:"Match the direction phrase to its meaning",pairs:[["tournez à gauche","turn left"],["allez tout droit","go straight"],["au coin de","at the corner of"],["à côté de","next to"],["continuez jusqu'à","continue until"]],explain:"These 5 direction phrases are the foundation of French navigation. Master them and you can give or receive directions anywhere in Quebec — from the Montreal metro system to Quebec City's historic streets. Being helpful to others with directions is a great way to connect with your community!",diff:1},
     {type:"fill",before:"Prenez la rue Saint-Denis, puis tournez à droite",blank:"___",after:"du boulevard de Maisonneuve.",options:["au coin","au bout","en face","à côté"],correct:0,explain:"Au coin de = at the corner of. Tournez à droite au coin du boulevard de Maisonneuve = Turn right at the corner of boulevard de Maisonneuve. Montreal's streets create a grid — au coin de is how Montrealers always give corner directions. Essential for the city!",diff:2},
     mcq("Someone says 'C'est à deux rues d'ici, sur votre gauche.' Where is the place?",["Two hours away, on the right","Two blocks from here, on your left","Two minutes walk, straight ahead","Two streets back, behind you"],1,"À deux rues d'ici = two blocks from here. Sur votre gauche = on your left. This is how Quebecers typically give walking directions — distance in rues (blocks) and then side. Much more useful than 'it's near there!'",1),
     {type:"scene",story:"A tourist stops Priya: 'Excusez-moi, je cherche le Musée des Beaux-Arts. Je suis complètement perdu!' Priya responds: 'Bien sûr! Allez tout droit sur la rue Sainte-Catherine jusqu'au coin de la rue Crescent. Tournez à gauche, et le musée est à deux rues sur votre droite, en face du parc.'",prompt:"What directions did Priya give?",options:["Go straight on Sainte-Catherine to Crescent corner, turn left, museum is 2 blocks on the right across from the park","Go right on Sainte-Catherine, then left at Crescent, museum is behind the park","Take the metro, then turn right, museum is next to a hotel","Go straight, then right, museum is 5 blocks away"],correct:0,explain:"Priya gave perfect French directions: allez tout droit (go straight), jusqu'au coin de (until the corner of), tournez à gauche (turn left), à deux rues (two blocks), sur votre droite (on your right), en face du parc (across from the park). She helped a tourist and represented her community beautifully!",diff:2},
     {type:"order",prompt:"Give directions: Turn right at the stop sign and continue straight",words:["Tournez","à","droite","au","panneau","d'arrêt","et","continuez","tout","droit"],answer:["Tournez","à","droite","au","panneau","d'arrêt","et","continuez","tout","droit"],explain:"Tournez à droite au panneau d'arrêt et continuez tout droit — panneau d'arrêt = stop sign (the Canadian French term). In Quebec, stop signs actually say ARRÊT, not STOP — another unique Quebec French feature! Perfect direction-giving in Quebec French.",diff:2},
     wr("Write directions from your home to your nearest metro or bus stop in French",["tournez à","allez tout droit","jusqu'à","au coin de","prenez la rue","à droite","à gauche"],"Writing directions from memory in French consolidates your knowledge of your neighbourhood in your new language. Share these directions with a friend or language partner — teaching directions is one of the best ways to practise!",2)]),

  mkL("a2-34","Expressing Cause & Consequence",25,"writing",
    "Explaining why things happen and what results from them is at the heart of sophisticated French communication. Job interview answers, formal letters, complaint letters, academic writing — all require cause and consequence language. Today you master these connectors that make your French arguments clear, logical, and persuasive.",
    ["parce que = because (most common)","car = because (more formal/written)","puisque = since/because (known reason)","à cause de = because of (+ noun)","grâce à = thanks to (positive cause)","c'est pourquoi = that's why","donc = therefore/so","ainsi = thus/therefore (formal)","par conséquent = as a result/consequently","en raison de = due to (formal)"],
    [mcq("Which expresses a POSITIVE cause? 'I got the job ___ my French skills.'",["à cause de mes compétences en français","en raison de mes compétences en français","grâce à mes compétences en français","puisque mes compétences en français"],2,"Grâce à = thanks to (POSITIVE cause). À cause de = because of (NEGATIVE/neutral cause). J'ai obtenu le poste grâce à mes compétences en français = I got the job thanks to my French skills. Use grâce à for good outcomes — never à cause de for something positive!",1),
     mcq("'Car' vs 'parce que' — which is more appropriate in a formal letter?",["Parce que is always better","Car is more formal and appropriate for written French","They are identical in all contexts","Car is spoken, parce que is written"],1,"Car = because (formal/written). Parce que = because (everyday speech and writing). In formal letters, job applications, and academic French, use car. Je n'ai pas pu assister à la réunion, car j'avais un rendez-vous médical = I couldn't attend the meeting, as I had a medical appointment.",2),
     {type:"match",prompt:"Match the connector to its function",pairs:[["parce que","gives a reason (spoken)"],["grâce à","positive cause (thanks to)"],["c'est pourquoi","introduces a consequence"],["par conséquent","formal 'therefore'"],["à cause de","because of (+ noun, negative)"]],explain:"Knowing WHEN to use each connector is as important as knowing the connector itself. Grâce à for positives, à cause de for negatives, car for formal writing, parce que for speech, c'est pourquoi/donc/par conséquent for consequences. This nuance is C1 level!",diff:2},
     {type:"fill",before:"Je n'ai pas pu me rendre au bureau",blank:"___",after:"une tempête de neige. (I couldn't get to the office because of a snowstorm.)",options:["à cause d'une","grâce à une","parce que une","car une"],correct:0,explain:"À cause de + noun = because of. À cause d'une tempête = because of a snowstorm (d' before vowel). This sentence is your Quebec winter excuse — and a legitimate one! Tempêtes de neige (snowstorms) genuinely close roads and cancel school in Quebec. Now you can explain it professionally!",diff:2},
     mcq("'Mon français s'est amélioré, ___ j'ai obtenu une promotion.' Choose the best connector:",["parce que","à cause de cela","c'est pourquoi","grâce à"],2,"C'est pourquoi = that's why (introduces a consequence of what was just said). Mon français s'est amélioré, c'est pourquoi j'ai obtenu une promotion = My French improved, that's why I got a promotion. C'est pourquoi connects cause → consequence perfectly in professional French!",2),
     {type:"scene",story:"In her cover letter, Sara writes: 'Je pose ma candidature car j'ai de l'expérience dans votre secteur. Grâce à ma formation bilingue, je peux communiquer efficacement avec tous vos clients. À cause des restructurations dans mon entreprise actuelle, je cherche de nouvelles opportunités. C'est pourquoi votre poste m'intéresse particulièrement.'",prompt:"How many cause/consequence connectors does Sara use and are they correct?",options:["4 connectors (car, grâce à, à cause de, c'est pourquoi) — all used correctly","2 connectors — some are incorrect","Sara doesn't use any connectors","She uses 3 connectors with one error"],correct:0,explain:"Sara masterfully uses 4 different connectors: car (formal because), grâce à (positive cause — her training), à cause de (neutral cause — restructuring), c'est pourquoi (consequence — why she's interested). This cover letter would stand out in any Quebec job application. This is the power of cause/consequence vocabulary!",diff:3},
     {type:"order",prompt:"Build: Thanks to my experience, I got the job therefore I am very happy",words:["Grâce","à","mon","expérience,","j'ai","obtenu","le","poste,","donc","je","suis","très","content"],answer:["Grâce","à","mon","expérience,","j'ai","obtenu","le","poste,","donc","je","suis","très","content"],explain:"Grâce à mon expérience, j'ai obtenu le poste, donc je suis très content — two connectors in one sentence! Grâce à (positive cause) + donc (consequence). This structure shows sophisticated argumentation. In job interviews, using cause/consequence language shows analytical thinking!",diff:2},
     wr("Write 2 sentences explaining why you came to Canada and what the result has been",["parce que","car","grâce à","à cause de","c'est pourquoi","donc","par conséquent"],"Articulating your journey to Canada with sophisticated cause/consequence language shows genuine French mastery. These same connectors appear in CLB/TEF written tasks — mastering them directly improves your exam scores AND your daily professional communication.",3)]),

  mkL("a2-35","Reflexive Verbs — Daily Life & Work",20,"speaking",
    "Reflexive verbs describe actions you do to yourself — getting up, washing, getting dressed, introducing yourself. They're incredibly common in French daily life, and many verbs that aren't reflexive in English ARE reflexive in French. Today you master reflexive verbs for your morning routine, workplace introductions, and social situations.",
    ["se lever = to get up","se laver = to wash","s'habiller = to get dressed","se souvenir de = to remember","s'appeler = to be called/named","se présenter = to introduce oneself","se tromper = to make a mistake","s'améliorer = to improve","se sentir = to feel","se débrouiller = to manage/cope"],
    [mcq("How do you say 'I get up at 6am every morning'?",["Je lève à 6h chaque matin","Je me lève à 6h chaque matin","Je suis levé à 6h chaque matin","Je lever à 6h chaque matin"],1,"Je me lève = I get up (reflexive: se lever). The reflexive pronoun me agrees with the subject je. Je me lève à 6h chaque matin — a sentence every Quebec commuter knows! CLSCs open at 8h, schools at 8h30 — being able to say your schedule matters.",1),
     mcq("At a networking event, how do you introduce yourself?",["Je m'appelle Ravi et je travaille dans la technologie","Je appelle Ravi","Mon nom est appeler Ravi","Je présente moi même Ravi"],0,"Je m'appelle = I am called/my name is (reflexive: s'appeler). Je me présente = I introduce myself (also reflexive!). Je m'appelle Ravi et je travaille dans la technologie = My name is Ravi and I work in technology. This is the standard professional introduction in Quebec.",1),
     {type:"match",prompt:"Match the reflexive verb to its meaning",pairs:[["se souvenir de","to remember"],["se tromper","to make a mistake"],["s'améliorer","to improve"],["se débrouiller","to manage/cope"],["se sentir","to feel"]],explain:"These 5 reflexive verbs are essential for talking about personal development and daily experience. Se débrouiller is particularly Quebec-important — it means to manage/get by, and Quebecers use it constantly: 'Tu te débrouilles bien en français!' (You're managing well in French!)",diff:1},
     {type:"fill",before:"Mon français",blank:"___",after:"beaucoup depuis que j'étudie avec Franco!",options:["s'améliore","améliore","est amélioré","m'améliore"],correct:0,explain:"S'améliorer = to improve (reflexive). Mon français s'améliore = My French is improving. Third person singular: il/elle/on s'améliore. This is a great sentence to say to your tutor or teacher! Notice: it's the French that is improving (not you improving it), hence reflexive.",diff:2},
     mcq("Your colleague says 'Je me suis trompé dans le rapport, désolé.' What happened?",["He forgot the report","He made a mistake in the report and is apologizing","He lost the report","He submitted the report late"],1,"Je me suis trompé = I made a mistake (reflexive, passé composé with être). Se tromper = to be wrong / to make a mistake. Désolé = sorry. This is the professional way to acknowledge an error in French — direct, honest, and polite. Much better than denying mistakes!",2),
     {type:"scene",story:"Amara's first week at her new Montreal job: 'Le matin, je me lève à 6h, je me prépare rapidement et je prends le métro. Au travail, je me présente à mes nouveaux collègues. Je me sens un peu nerveuse mais je me dis que ça va s'améliorer. Je me débrouille bien en français — mieux que je ne le pensais!'",prompt:"Count how many reflexive verbs Amara uses correctly",options:["7 reflexive verbs: me lève, me prépare, me présente, me sens, me dis, s'améliorer, me débrouille","3 reflexive verbs","5 reflexive verbs","No reflexive verbs"],correct:0,explain:"Amara uses 7 reflexive verbs perfectly: me lève (get up), me prépare (get ready), me présente (introduce myself), me sens (feel), me dis (tell myself), s'améliorer (to improve), me débrouille (manage). This authentic French describes immigrant experience beautifully — and correctly!",diff:3},
     {type:"order",prompt:"Say your morning: I wake up, I get washed, I get dressed, and I take the metro",words:["Je","me","lève,","je","me","lave,","je","m'habille","et","je","prends","le","métro"],answer:["Je","me","lève,","je","me","lave,","je","m'habille","et","je","prends","le","métro"],explain:"Je me lève, je me lave, je m'habille et je prends le métro — four verbs describing a complete morning routine! Three are reflexive (me lève, me lave, m'habille) and one is regular (prends). Notice m'habille not je m'habille — the elision before vowel. Daily vocabulary at its most practical!",diff:2},
     wr("Describe your typical morning in French using at least 3 reflexive verbs",["je me lève","je me prépare","je me lave","je m'habille","je me sens","je me dépêche","je me rends"],"Describing your daily routine in French builds automaticity — the ability to speak without thinking about grammar. When you can describe your morning reflexively, your French has become natural. This is what fluency feels like!",2)]),

  mkL("a2-36","Formal Writing — Reports & Summaries",30,"writing",
    "In Quebec workplaces and for CLB written tests, you need to write formal reports, meeting summaries, and structured documents. Today you learn the architecture of formal French writing: how to structure a report, write a clear summary, use formal connectors, and produce professional documents that impress Quebec employers and exam evaluators.",
    ["En premier lieu = First of all","Deuxièmement / En second lieu = Secondly","Par ailleurs = Moreover / Furthermore","En outre = In addition (very formal)","Cependant / Toutefois = However","En conclusion = In conclusion","Il convient de noter que = It is worth noting that","Suite à = Following","En ce qui concerne = Regarding","Veuillez noter que = Please note that"],
    [mcq("Which connector introduces a contrasting idea in formal writing?",["De plus","En premier lieu","Cependant","Car"],2,"Cependant = however (contrasting connector for formal writing). Toutefois also works. En premier lieu (first), de plus (furthermore), car (because) — each serves a different function. Cependant is perfect when you want to present a counterpoint professionally.",1),
     mcq("A formal report begins 'Suite à la réunion du 15 avril...' What does this mean?",["Before the April 15th meeting","During the April 15th meeting","Following the April 15th meeting","Instead of the April 15th meeting"],2,"Suite à = following/as a result of. This is a standard opening for meeting minutes and follow-up reports in Quebec workplaces. Suite à notre conversation téléphonique, suite à la réunion, suite à votre demande — these openings signal a professional follow-up document.",1),
     {type:"match",prompt:"Match the formal connector to its function",pairs:[["En premier lieu","introduces first point"],["Par ailleurs","adds additional point"],["Cependant","introduces contrast"],["En conclusion","closes the document"],["Il convient de noter que","draws attention to important point"]],explain:"These 5 formal connectors structure professional French documents. A well-structured report with these connectors shows organizational intelligence AND language sophistication. They're also common in CLB/TEF writing test evaluation criteria — using them correctly improves your score.",diff:2},
     {type:"fill",before:"",blank:"___",after:"notre conversation du 10 mars, je vous transmets le compte rendu de la réunion.",options:["Suite à","En raison de","Grâce à","En ce qui concerne"],correct:0,explain:"Suite à + noun = following. Suite à notre conversation = following our conversation. This is the most professional way to open a follow-up document in Quebec French. It immediately establishes context and shows the reader why you're writing.",diff:2},
     mcq("Which sentence is most appropriate for a formal business report?",["En premier lieu, il faut noter que les résultats sont positifs.","D'abord les résultats c'est bien.","Les résultats sont bons en premier.","Primo les résultats sont OK."],0,"En premier lieu, il faut noter que = First of all, it should be noted that. This formal structure is perfect for business reports. Il faut noter que draws attention formally. The other options are too casual or grammatically awkward for professional French.",2),
     {type:"scene",story:"Priya writes a workplace summary: 'Suite à la réunion du 20 avril, voici le compte rendu. En premier lieu, l'équipe a discuté des objectifs du deuxième trimestre. Par ailleurs, il a été décidé d'augmenter le budget marketing. Cependant, certains membres ont exprimé des réserves. En conclusion, une décision finale sera prise lors de la prochaine réunion.'",prompt:"How many formal connectors does Priya use and what's the effect?",options:["5 connectors (suite à, en premier lieu, par ailleurs, cependant, en conclusion) — professional, well-structured document","2 connectors — average report","No connectors — informal document","Priya made errors in her connectors"],correct:0,explain:"Priya uses 5 formal connectors perfectly, creating a clear structure: opening (suite à), first point (en premier lieu), addition (par ailleurs), contrast (cependant), conclusion (en conclusion). This account rendu would be impressive in any Quebec workplace. Her French is at a professional level!",diff:3},
     {type:"order",prompt:"Build a formal conclusion: In conclusion, the project was a success",words:["En","conclusion,","le","projet","a","été","un","succès"],answer:["En","conclusion,","le","projet","a","été","un","succès"],explain:"En conclusion, le projet a été un succès — using passive voice (a été) AND a formal connector (en conclusion). This closing sentence would end a professional French report perfectly. En conclusion followed by a clear statement is expected in all formal French documents.",diff:2},
     wr("Write a 3-sentence formal summary of a real meeting or event using formal connectors",["en premier lieu","par ailleurs","cependant","en conclusion","suite à","il convient de noter","toutefois"],"Writing formal summaries with appropriate connectors is a skill tested directly in CLB/TEF writing exams. It's also the most common professional writing task in Quebec workplaces. Master this structure and you succeed both in exams and at work!",3)]),

  mkL("a2-37","Understanding Quebec Bureaucracy",25,"mixed",
    "Quebec has a lot of paperwork — immigration documents, healthcare forms, tax returns, social insurance, school registration. Navigating French bureaucracy confidently is one of the most important practical skills for immigrants. Today you learn the vocabulary, common phrases, and strategies to handle any Quebec government interaction with confidence.",
    ["remplir un formulaire = to fill out a form","soumettre une demande = to submit an application","joindre les pièces justificatives = to attach supporting documents","délai de traitement = processing time","accusé de réception = acknowledgment of receipt","en attente = pending/waiting","approuvé = approved","refusé = rejected","faire appel = to appeal","un numéro de référence = a reference number"],
    [mcq("A government letter says 'Votre demande est en attente de traitement.' What is the status?",["Your application was approved","Your application is waiting to be processed","Your application was rejected","Your application needs more documents"],1,"En attente de traitement = waiting for/pending processing. This is one of the most common status messages from Quebec government offices. Keep your reference number (numéro de référence) and check back after the stated délai de traitement (processing time)!",1),
     mcq("The form says 'Joignez les pièces justificatives suivantes.' What must you do?",["Sign the form","Attach the required supporting documents","Submit the form online","Pay the required fee"],1,"Joindre les pièces justificatives = to attach supporting documents. This instruction appears on virtually every Quebec government form. Always check what documents are required BEFORE starting your application — missing documents cause delays!",1),
     {type:"match",prompt:"Match the bureaucracy term to its meaning",pairs:[["un accusé de réception","acknowledgment of receipt"],["délai de traitement","processing time"],["faire appel","to appeal"],["approuvé","approved"],["un numéro de référence","a reference number"]],explain:"These 5 bureaucracy terms appear on every Quebec government letter and form. Keeping your accusé de réception and numéro de référence is crucial — you'll need them for follow-up communications. En attente → approuvé or refusé → faire appel if needed. Know this sequence!",diff:1},
     {type:"fill",before:"Veuillez",blank:"___",after:"ce formulaire en trois exemplaires et joindre votre acte de naissance.",options:["remplir","remplissez","rempli","remplirez"],correct:0,explain:"Veuillez + infinitif = please (formal imperative). Veuillez remplir = please fill out. En trois exemplaires = in three copies (common on Quebec forms!). Acte de naissance = birth certificate. This instruction appears on immigration, RAMQ, and school registration forms.",diff:2},
     mcq("Your application was refused. The letter says you have 30 days to 'faire appel'. What should you do?",["Nothing — accept the decision","Leave Quebec","Submit an appeal within 30 days","Reapply from scratch"],2,"Faire appel = to appeal. If your government application is refused, you often have the right to appeal within a specific delay. This is an important legal right — many refused applications are overturned on appeal. The Tribunal administratif du Québec (TAQ) handles these appeals!",2),
     {type:"scene",story:"Amara receives a letter from the SAAQ: 'Nous avons bien reçu votre demande de permis de conduire. Délai de traitement estimé: 4 à 6 semaines. Votre numéro de référence est le 2026-04-15892. Un accusé de réception vous a été envoyé par courriel. Les documents suivants sont en cours de vérification: votre passeport, votre permis étranger et votre preuve de résidence.'",prompt:"What information does Amara need to record?",options:["Reference number 2026-04-15892; processing time 4-6 weeks; 3 documents being verified (passport, foreign licence, proof of residence)","Just the reference number","Only that her application was received","The processing time only"],correct:0,explain:"Amara correctly identifies: numéro de référence (2026-04-15892), délai de traitement (4-6 semaines), and the three pièces justificatives en cours de vérification (passport, foreign license, proof of residence). She should save this letter — her reference number is crucial for any follow-up with the SAAQ!",diff:2},
     {type:"order",prompt:"Say: I would like to submit my application with the required documents",words:["Je","voudrais","soumettre","ma","demande","avec","les","pièces","justificatives","requises"],answer:["Je","voudrais","soumettre","ma","demande","avec","les","pièces","justificatives","requises"],explain:"Je voudrais soumettre ma demande avec les pièces justificatives requises — professional and complete. This sentence works at any Quebec government counter. Requises = required (feminine plural to agree with pièces). You now speak bureaucratic French!",diff:2},
     wr("Write what you would say to ask about the status of your application in French",["quel est le statut","ma demande","numéro de référence","en attente","j'ai soumis","il y a","je voudrais savoir"],"Quel est le statut de ma demande? Mon numéro de référence est le... — These two sentences, combined with your reference number, get you information from any Quebec government office. Confident bureaucratic French is a superpower for immigrants. Practice until these phrases are automatic!",2)]),

  mkL("a2-38","False Friends — French Words That Aren't What They Seem",20,"mixed",
    "False friends (faux amis) are French words that look like English words but mean something completely different. They cause embarrassing mistakes and miscommunications. 'Je suis excité' doesn't mean excited, 'rester' doesn't mean rest, 'sensible' doesn't mean sensible — today you learn the most dangerous false friends so you never embarrass yourself again!",
    ["excité = sexually aroused (NOT excited!)","enthousiaste = excited (use this instead)","rester = to stay (NOT to rest)","se reposer = to rest (use this)","sensible = sensitive (NOT sensible)","raisonnable = sensible/reasonable","assister à = to attend (NOT to assist)","aider = to assist/help","actuellement = currently (NOT actually)","en fait / en réalité = actually"],
    [mcq("Your boss says 'Je suis très excité par ce projet.' What does this mean in French?",["He is sexually aroused by the project (awkward!)","He is enthusiastic/excited about the project","He is worried about the project","He is bored by the project"],1,"In formal/professional French, excité can mean enthusiastic, but its primary meaning is sexually aroused — this causes frequent misunderstandings! Better: je suis enthousiaste, je suis ravi, je suis impatient de... Use these instead of excité in professional contexts!",2),
     mcq("'Actuellement, je travaille chez Desjardins.' What does actuellement mean here?",["Actually (correcting something)","Currently/at the moment","Eventually","Annually"],1,"Actuellement = currently, at the moment — NOT 'actually'! En fait or en réalité = actually. Actuellement, je travaille = I currently work. This faux ami causes constant mistakes among English speakers learning French!",1),
     {type:"match",prompt:"Match the faux ami to its TRUE French meaning",pairs:[["rester","to stay (not 'to rest')"],["sensible","sensitive (not 'sensible')"],["assister à","to attend (not 'to assist')"],["actuellement","currently (not 'actually')"],["une librairie","a bookstore (not 'library')"]],explain:"These 5 faux amis cause the most miscommunications between French and English! Une librairie = bookstore (une bibliothèque = library). Assister à la réunion = to attend the meeting (not to help with the meeting). These mistakes happen daily — now you're protected!",diff:1},
     {type:"fill",before:"Je vais",blank:"___",after:"chez moi ce week-end. (I'm going to rest at home this weekend.)",options:["me reposer","rester","assister","actuellement"],correct:0,explain:"Se reposer = to rest. Je vais me reposer = I'm going to rest. Rester = to stay. Je vais rester = I'm going to stay. If you say 'je vais rester chez moi', you're staying home (maybe watching Netflix!) — which might also be true, but isn't quite the same as resting!",diff:2},
     mcq("'Cette personne est très sensible.' What does this describe?",["A sensible, reasonable person","A sensitive, emotional person","A logical person","A practical person"],1,"Sensible in French = sensitive, easily affected by emotions. It does NOT mean sensible/reasonable — that's raisonnable in French. 'Elle est très sensible' = She is very sensitive. 'Il est très raisonnable' = He is very sensible/reasonable. This faux ami causes many cross-cultural misunderstandings!",1),
     {type:"scene",story:"At a meeting, James (English background learning French) says: 'Je suis très excité! Actuellement, j'assiste mon patron avec ce projet important. On va rester après la réunion pour se reposer ensemble.' His French colleagues look confused.",prompt:"How many faux ami errors did James make?",options:["4 errors: excité (should be enthousiaste), actuellement (should be en fait), assiste (should be aide), rester/se reposer (confused meanings)","1 error: excité","2 errors","No errors — his French is correct"],correct:0,explain:"James made 4 faux ami errors! Excité (should say enthousiaste for professional enthusiasm), actuellement (he means 'currently', but used it correctly — but then suggests he actually means 'at the moment' it's fine!), assiste mon patron (should be j'aide), and rester pour se reposer makes no sense together! Learning these faux amis prevents exactly these situations.",diff:3},
     {type:"order",prompt:"Correct sentence: I am currently enthusiastic about attending this meeting",words:["Actuellement,","je","suis","enthousiaste","à","l'idée","d'assister","à","cette","réunion"],answer:["Actuellement,","je","suis","enthousiaste","à","l'idée","d'assister","à","cette","réunion"],explain:"Actuellement (currently) + enthousiaste (enthusiastic, not excité) + assister à (to attend, not to assist). Three potential faux ami traps avoided perfectly! This sentence demonstrates mastery of the three most dangerous faux amis in professional French.",diff:2},
     wr("Write a sentence using one faux ami correctly (use the TRUE French meaning)",["actuellement","sensible","rester","assister à","raisonnable","enthousiaste","se reposer"],"Avoiding faux amis is one of the most valuable skills for English speakers learning French. Every faux ami you master prevents a future misunderstanding or embarrassment. Make a personal list of faux amis that affect you most — revisit it weekly!",2)]),

  mkL("a2-39","The CLB Framework — Understanding Your Level",25,"mixed",
    "The Canadian Language Benchmarks (CLB) is the system used to measure French ability in Canada. Every language test for immigration — the TEF Canada, the TCF Canada — is mapped to CLB levels. Understanding what each level means, what skills are required, and how to advance is crucial strategic knowledge for your Canadian journey. Today you understand the system you're working within.",
    ["CLB = Canadian Language Benchmarks","TEF Canada = Test d'Évaluation de Français (for immigration)","TCF Canada = Test de Connaissance du Français (for immigration)","CLB 4 = minimum for citizenship","CLB 5 = threshold for many professional programs","CLB 7 = professional level, university entrance","les 4 compétences = the 4 skills (écoute, expression orale, lecture, écriture)","une note de passage = a passing score","s'exprimer oralement = to express oneself orally","la compréhension de l'écoute = listening comprehension"],
    [mcq("You need CLB 4 in all 4 skills for Canadian citizenship. What does CLB 4 mean?",["You can barely communicate in French","You can communicate in familiar situations on everyday topics with some errors","You are completely fluent","You need university-level French"],1,"CLB 4 = Intermediate level. You can handle everyday communication, understand familiar topics, and make yourself understood, though with errors. For citizenship, CLB 4 in reading, writing, listening, AND speaking is required. You're well on your way with Franco!",1),
     mcq("The TEF Canada tests which skills?",["Only writing and speaking","Only reading and listening","All 4 skills: listening, speaking, reading, and writing","Only speaking"],2,"TEF Canada tests all 4 compétences: compréhension de l'écoute (listening), expression orale (speaking), compréhension écrite (reading), and expression écrite (writing). Each skill is scored separately — you need a minimum CLB level in ALL four. Plan and prepare for each skill individually!",1),
     {type:"match",prompt:"Match the CLB level to its description",pairs:[["CLB 4","communicates in everyday situations, some errors"],["CLB 5","handles most social and workplace situations"],["CLB 7","professional level, can study in French"],["CLB 9","near-native fluency"],["CLB 12","equivalent to educated native speaker"]],explain:"Understanding CLB levels strategically transforms your preparation. CLB 4 = citizenship minimum. CLB 5 = most government jobs. CLB 7 = university/professional programs. CLB 9+ = native-speaker equivalent. Knowing your target level focuses your preparation and prevents over-studying (or under-preparing)!",diff:2},
     {type:"fill",before:"Pour ma demande de résidence permanente, j'ai besoin d'un",blank:"___",after:"CLB 7 en expression orale et en compréhension de l'écoute.",options:["résultat minimum de","score","niveau","nombre"],correct:0,explain:"Résultat minimum de = minimum score of. Un résultat minimum de CLB 7 = a minimum score of CLB 7. This is how immigration applications describe language requirements. Knowing this vocabulary helps you read and understand the requirements for YOUR specific immigration pathway!",diff:2},
     mcq("Which skill do most immigrants find hardest in the TEF Canada?",["Reading","Writing","Speaking (expression orale) — because of time pressure and nervousness","Listening"],2,"Expression orale (speaking) is statistically the most challenging for TEF Canada candidates — time pressure (you must speak for 1.5-3 minutes continuously), unfamiliar topics, and exam nerves all contribute. The good news: practicing with Franco's AI tutor Sophie is direct preparation for this skill!",2),
     {type:"scene",story:"Ravi researches TEF Canada results needed for Express Entry: 'Pour la résidence permanente via Entrée express, j'ai besoin d'au moins CLB 7 en expression orale et en compréhension de l'écoute, et CLB 6 en expression écrite et en compréhension écrite. Actuellement, mon niveau est estimé à CLB 5-6 selon mes résultats chez Franco. Il me faut donc travailler plus intensément sur l'expression orale.'",prompt:"What is Ravi's strategic plan based on CLB requirements?",options:["He needs CLB 7 in speaking/listening and CLB 6 in writing/reading; he's at CLB 5-6; must focus on speaking","He already has all required levels","He needs CLB 9 in all skills","He doesn't need to prepare further"],correct:0,explain:"Ravi's analysis is perfect: identifies target levels (CLB 7 oral/listening, CLB 6 written), assesses his current level (CLB 5-6), identifies the gap (especially in expression orale), and creates a focus strategy. This is exactly how to prepare strategically for immigration language tests. Franco's curriculum is designed precisely for this journey!",diff:2},
     {type:"order",prompt:"State your goal: I need to reach CLB 7 in all four skills for my immigration application",words:["J'ai","besoin","d'atteindre","le","CLB","7","dans","les","quatre","compétences","pour","ma","demande","d'immigration"],answer:["J'ai","besoin","d'atteindre","le","CLB","7","dans","les","quatre","compétences","pour","ma","demande","d'immigration"],explain:"J'ai besoin d'atteindre le CLB 7 dans les quatre compétences pour ma demande d'immigration — your immigration language goal in perfect French! Atteindre = to reach/achieve. Les quatre compétences = the four skills. Say this goal out loud every day — commitment in French accelerates learning!",diff:2},
     wr("Write your personal CLB goal and what you need to do to achieve it",["j'ai besoin de","CLB","expression orale","compréhension","je dois","travailler sur","mon objectif est","pour ma demande"],"Writing your CLB goal in French makes it real and activates commitment. Research your specific immigration pathway requirements at IRCC.Canada.ca — every program has different CLB requirements. Franco's curriculum is structured to take you from foundation to CLB 7 step by step. You can do this!",2)]),

  mkL("a2-40","Review & Integration — A2 Mastery",30,"mixed",
    "Congratulations — you've completed the A2 level! This review lesson integrates everything you've learned: grammar structures, vocabulary, Canadian context, and communication strategies. Today you demonstrate your A2 mastery with complex scenarios that combine multiple skills. You are ready to communicate in French in everyday Canadian life. B1 awaits!",
    ["Review: passé composé + imparfait together","Review: conditionnel for politeness","Review: relative clauses (qui, que, où)","Review: subjunctive with il faut que","Review: cause/consequence connectors","Review: formal writing structure","Review: passive voice recognition","Review: object pronouns (le, la, les, lui, leur)","Review: Quebec-specific vocabulary","Achievement: A2 = CLB 3-4 foundation complete"],
    [mcq("Which sentence combines A2 grammar correctly? (relative clause + conditionnel)",["Je voudrais un emploi qui correspond à mes compétences","Je voudrais un emploi que correspond à mes compétences","Je voudrais un emploi qui correspondrait mais","Je veux emploi qui correspond"],0,"Je voudrais (conditionnel — polite) + qui correspond (relative clause — qui as subject). Two A2 structures perfectly combined. This sentence works in any Quebec job interview or application!",2),
     {type:"match",prompt:"Match each A2 skill to a real Quebec situation",pairs:[["passé composé + imparfait","telling your immigration story"],["conditionnel","politely requesting anything"],["relative clause","describing what you need"],["cause/consequence","explaining your decisions"],["formal connectors","writing workplace reports"]],explain:"A2 French isn't just grammar — it's a toolkit for real Quebec life! Each structure serves a practical purpose: sharing your story, requesting politely, describing needs, reasoning logically, and writing professionally. You now have all these tools.",diff:2},
     {type:"fill",before:"Je cherche un poste",blank:"___",after:"je pourrais développer mes compétences en français.",options:["où","qui","que","dont"],correct:0,explain:"Où for place/time/situation relative clause. Un poste où = a position where. Je cherche un poste où je pourrais développer mes compétences = I'm looking for a position where I could develop my skills. Où + conditionnel = sophisticated job search French!",diff:2},
     mcq("Translate naturally: 'Although my French isn't perfect yet, I am improving every day thanks to practice.'",["Bien que mon français n'est pas parfait encore, j'améliore chaque jour grâce à la pratique","Bien que mon français ne soit pas encore parfait, je m'améliore chaque jour grâce à la pratique","Mon français n'est pas parfait mais je m'améliore chaque jour","Bien que mon français n'était pas parfait, j'améliorais chaque jour"],1,"Bien que + subjonctif (ne soit pas). Je m'améliore = reflexive (s'améliorer). Grâce à (positive cause). Encore = yet (after verb in French). Three A2 structures in one sentence: subjunctive after bien que, reflexive verb, cause connector. This is real A2 mastery!",3),
     {type:"scene",story:"Complete integration scenario: Ravi writes to a Quebec employer: 'Je vous écris car j'ai vu votre annonce pour le poste d'ingénieur que vous avez publié la semaine dernière. Grâce à mes dix ans d'expérience, je pense pouvoir contribuer significativement à votre équipe. Bien que mon français ne soit pas encore parfait, il s'améliore chaque jour. Je voudrais vous demander si une entrevue serait possible.'",prompt:"Identify all A2 structures Ravi uses correctly",options:["car (cause), que relative clause, grâce à (positive cause), bien que + subjonctif, reflexive s'améliore, conditionnel voudrais — all correct!","Only passé composé and présent","No A2 structures — just basic French","Some errors in the subjunctive"],correct:0,explain:"Ravi uses 6 A2 structures: car (formal cause), que (relative pronoun), grâce à (positive cause), bien que + subjonctif ne soit pas, s'améliore (reflexive), voudrais (conditionnel). This cover letter demonstrates complete A2 integration — language that gets interviews in Quebec! You can write this too.",diff:3},
     {type:"order",prompt:"Write your A2 achievement sentence: I can now communicate in French in everyday Canadian life",words:["Je","peux","maintenant","communiquer","en","français","dans","la","vie","quotidienne","canadienne"],answer:["Je","peux","maintenant","communiquer","en","français","dans","la","vie","quotidienne","canadienne"],explain:"Je peux maintenant communiquer en français dans la vie quotidienne canadienne — your A2 achievement statement! Maintenant = now. La vie quotidienne = daily life. Canadienne = Canadian (feminine, agreeing with vie). Say this with pride — you've earned it! B1 begins now.",diff:1},
     wr("Write a short paragraph (3-4 sentences) about your French learning journey and goals using A2 structures",["grâce à","bien que","je me suis amélioré","j'ai appris","car","c'est pourquoi","je voudrais","où","qui"],"This paragraph is your A2 capstone. Using multiple A2 structures naturally in connected writing shows you've truly internalized this level. Save this paragraph — read it again when you complete B1. The progress you've made is real, measurable, and meaningful for your Canadian life. Félicitations! 🍁",3)]),
];

const B1_LESSONS = [
  mkL("b1-01","Expressing Opinions Professionally",30,"speaking",
    "At CLB 5, you need to express opinions clearly, back them up with reasons, and acknowledge other viewpoints. This is tested in TEF Canada speaking and writing sections. Today you learn the complete toolkit for sophisticated opinion expression — the language of debates, meetings, and professional discussions in Quebec.",
    ["À mon avis = In my opinion","Selon moi = According to me","Il me semble que = It seems to me that","Je suis convaincu(e) que = I am convinced that","D'un côté... de l'autre = On one hand... on the other","Certes... mais = Granted... but","Je partage votre avis = I share your opinion","Je ne suis pas tout à fait d'accord = I don't entirely agree","Il faut admettre que = One must admit that","En revanche = On the other hand / However"],
    [mcq("Which phrase introduces a nuanced disagreement most professionally?",["Tu as tort","Je ne suis pas tout à fait d'accord, car...","Non c'est faux","Je désaccorde"],1,"Je ne suis pas tout à fait d'accord = I don't entirely agree — professional, nuanced, and respectful. It signals you have a different perspective without being confrontational. In Quebec workplaces, this phrase keeps discussions productive. Follow it with car (because) + your reason.",1),
     mcq("You want to acknowledge a valid point before disagreeing. You say:",["Non mais...","Certes, cet argument est valide, mais il faut également considérer...","C'est vrai je suppose","Vous avez raison complètement"],1,"Certes = granted/admittedly. Certes + acknowledgment + mais + your point = sophisticated argumentation. This structure shows you've listened AND have something to add. It's the mark of a confident, respectful debater in French.",1),
     {type:"match",prompt:"Match the opinion phrase to its function",pairs:[["À mon avis","personal opinion opener"],["D'un côté... de l'autre","balanced perspective"],["Il faut admettre que","acknowledging a valid point"],["En revanche","contrasting point"],["Je suis convaincu(e) que","strong conviction"]],explain:"These 5 structures give you complete opinion expression at B1 level. Using varied openers (not just 'je pense') shows vocabulary range. Contrasting (en revanche, certes... mais) shows balanced thinking. Both are evaluated in TEF Canada speaking!",diff:2},
     {type:"fill",before:"",blank:"___",after:"le bilinguisme est un avantage important sur le marché du travail québécois.",options:["Je suis convaincu que","Je pense","À mon avis,","Il me semble"],correct:0,explain:"Je suis convaincu(e) que = I am convinced that — the strongest opinion marker. For a statement as important as bilingualism's job market value, this strong conviction is appropriate. Je suis convaincu que le bilinguisme est un avantage = I am convinced bilingualism is an advantage. Powerful and professional!",diff:2},
     {type:"scene",story:"In her TEF Canada speaking test, Amara is asked: 'Pensez-vous que l'immigration est bénéfique pour le Québec?' She responds: 'À mon avis, l'immigration apporte des avantages considérables. D'un côté, elle enrichit la culture québécoise. De l'autre, certes, des défis d'intégration existent. En revanche, il faut admettre que des politiques d'accueil efficaces peuvent les surmonter. Je suis convaincue que le Québec bénéficie grandement de sa diversité.'",prompt:"How many B1 opinion structures does Amara use?",options:["5 structures: à mon avis, d'un côté/de l'autre, certes, en revanche, il faut admettre, je suis convaincue","2 structures","3 structures","1 structure"],correct:0,explain:"Amara uses 5+ B1 opinion structures in 4 sentences — exactly what TEF Canada evaluators look for! The variety of opinion markers, balanced argument structure, and confident conclusion would score well at CLB 5-6. This is the standard to aim for!",diff:3},
     {type:"order",prompt:"Build: On one hand immigration enriches culture on the other it presents challenges",words:["D'un","côté,","l'immigration","enrichit","la","culture,","de","l'autre,","elle","présente","des","défis"],answer:["D'un","côté,","l'immigration","enrichit","la","culture,","de","l'autre,","elle","présente","des","défis"],explain:"D'un côté... de l'autre = on one hand... on the other. This structure is worth memorizing exactly — it automatically creates a balanced argument in French. TEF Canada speaking tasks often ask you to discuss advantages and disadvantages. This structure is your template!",diff:2},
     wr("Write your opinion on whether French should be required for all jobs in Quebec using B1 opinion structures",["à mon avis","certes","en revanche","il faut admettre","d'un côté","de l'autre","je suis convaincu(e)"],"A structured opinion on Quebec language policy — a topic you might face in TEF Canada! Practice this type of response: 2-3 minutes, balanced argument, varied opinion markers. Record yourself and evaluate: did you use at least 4 different opinion structures?",3)]),

  mkL("b1-02","CLB 5 Speaking — Conversation Skills",30,"speaking",
    "CLB 5 speaking means you can participate in extended conversations on familiar and some unfamiliar topics, express and justify opinions, and deal with unexpected situations. Today you practice the strategies that make B1 speakers stand out: managing conversations, buying time, repairing communication breakdowns, and extending your responses.",
    ["Pour répondre à cette question... = To answer this question...","C'est une bonne question... = That's a good question...","Ce qui me vient à l'esprit c'est... = What comes to mind is...","Si je comprends bien... = If I understand correctly...","Pourriez-vous préciser? = Could you clarify?","En d'autres termes = In other words","Pour élaborer davantage = To elaborate further","En ce qui me concerne = As far as I'm concerned","Pour revenir à votre question = To return to your question","Je veux dire que = What I mean is"],
    [mcq("In a TEF Canada speaking test, you don't understand a question. You should:",["Say nothing and wait","Ask the examiner: 'Si je comprends bien, vous me demandez de...' or 'Pourriez-vous préciser?'","Switch to English","Give any random answer"],1,"Pourriez-vous préciser? = Could you clarify? or Si je comprends bien = If I understand correctly. These are NOT weaknesses — they show sophisticated communication management! Examiners EXPECT these strategies. Asking for clarification appropriately is a CLB 5+ skill.",1),
     mcq("You need time to think of your answer. You say:",["Uhh... uhh...","C'est une bonne question. Pour répondre à cette question, il faut considérer...","Je ne sais pas","I think..."],1,"C'est une bonne question = That's a good question (buying time). Pour répondre à cette question = to answer this question (more time while showing you're organized). These fillers keep the conversation flowing professionally. Never stay silent — keep speaking even while organizing your thoughts!",1),
     {type:"match",prompt:"Match the conversation strategy to its purpose",pairs:[["Pourriez-vous préciser?","asking for clarification"],["En d'autres termes","rephrasing/clarifying your own point"],["Pour élaborer davantage","extending your response"],["Si je comprends bien","checking your understanding"],["Pour revenir à votre question","refocusing the conversation"]],explain:"These 5 conversation management strategies are what distinguish CLB 5 speakers. They show you can manage real communication challenges — not just perform rehearsed scripts. Use them naturally and your TEF Canada speaking score will reflect it!",diff:2},
     {type:"fill",before:"",blank:"___",after:"mon expérience personnelle, l'immigration est une aventure qui demande beaucoup de courage.",options:["En ce qui concerne","Selon","D'après","Pour"],correct:0,explain:"En ce qui concerne = as far as... is concerned / regarding. En ce qui concerne mon expérience personnelle = as far as my personal experience is concerned. This phrase personalizes your response elegantly. TEF Canada speaking tasks often invite personal examples — this is your connector!",diff:2},
     mcq("After giving one reason, how do you extend your TEF response to get a higher score?",["Stop talking","Pour élaborer davantage, je voudrais ajouter que... / De plus, il faut considérer que...","Change topics","Ask the examiner what to say next"],1,"Pour élaborer davantage = to elaborate further. This phrase signals you have more to say and keeps the examiner engaged. TEF Canada speaking is scored on length AND quality — aim for 1.5-3 minutes per response. De plus, par exemple, en outre — keep extending!",2),
     {type:"scene",story:"TEF Canada speaking prompt: 'Décrivez un défi que vous avez surmonté au Canada.' Ravi responds: 'C'est une bonne question. Pour répondre, il faut que je parle de mon arrivée à Montréal. En ce qui me concerne, le plus grand défi était la barrière linguistique. Pour élaborer davantage, dans les premiers mois, je ne comprenais pas le québécois parlé rapidement. Mais, si je comprends bien ce que vous cherchez, vous voulez aussi savoir comment j'ai surmonté ce défi. J'ai donc suivi des cours intensifs et regardé des émissions québécoises. En d'autres termes, l'immersion totale a été ma stratégie.'",prompt:"How many B1 speaking strategies does Ravi use?",options:["5+ strategies: buying time, en ce qui me concerne, pour élaborer, si je comprends bien, en d'autres termes — excellent response!","2 strategies","No strategies — just content","Only 1 strategy"],correct:0,explain:"Ravi's response demonstrates 5 speaking strategies: C'est une bonne question (time buying), en ce qui me concerne (personalization), pour élaborer davantage (extension), si je comprends bien (checking comprehension), en d'autres termes (rephrasing). This is a CLB 6 response! The strategies themselves boost your score.",diff:3},
     {type:"order",prompt:"Buy time and start: That's a good question, to answer this question I need to think about...",words:["C'est","une","bonne","question.","Pour","répondre","à","cette","question,","il","faut","que","je","réfléchisse..."],answer:["C'est","une","bonne","question.","Pour","répondre","à","cette","question,","il","faut","que","je","réfléchisse..."],explain:"C'est une bonne question. Pour répondre à cette question, il faut que je réfléchisse — perfect time-buying opener with subjunctive (il faut que je réfléchisse)! This buys you 5-8 seconds while showing sophistication. Practice saying this NATURALLY until it flows automatically.",diff:2},
     wr("Practice a 5-sentence TEF Canada style response about your experience adapting to Quebec life",["c'est une bonne question","en ce qui me concerne","pour élaborer","d'un côté","en revanche","il faut admettre","en d'autres termes"],"Record yourself giving this response. Aim for 90 seconds minimum. Use at least 4 B1 speaking strategies. Listen back: did you sound confident? Did you use varied opinion and conversation structures? This practice IS the TEF Canada preparation!",3)]),

  mkL("b1-03","B1 Writing — Structured Arguments",35,"writing",
    "CLB 5 writing requires you to write well-organized texts expressing opinions, describing situations, and making arguments. The TEF Canada écriture section gives you a topic and 45 minutes. Today you learn the exact structure that scores CLB 5-6 in the writing test: introduction with position, two-three body paragraphs with evidence, conclusion with recommendation.",
    ["Structure: Introduction + 2-3 paragraphs + Conclusion","Introduction: présenter le sujet + votre position","Paragraphe 1: premier argument + exemple","Paragraphe 2: deuxième argument + exemple","Paragraphe 3: nuance/contre-argument + réfutation","Conclusion: résumé + recommandation/perspective","Longueur idéale: 200-250 mots pour CLB 5","Lisibilité: phrases claires, vocabulaire varié","Cohérence: chaque paragraphe = une idée principale","Transitions: en premier lieu, de plus, cependant, en conclusion"],
    [mcq("For a TEF Canada writing task, what is the minimum word count for CLB 5?",["50-100 words","150-175 words","200-250 words","300-350 words"],2,"200-250 words is the target for CLB 5 writing tasks. Below 200 = insufficient development. Above 350 = time risk. Quality over quantity, but you MUST reach 200 words minimum. Count your words as you write — don't go under!",1),
     mcq("A strong TEF Canada introduction should:",["Repeat the question word for word","Present the topic AND state your position clearly in 2-3 sentences","Write only 1 sentence","Start with a personal story immediately"],1,"Introduction: contextualize the topic (1-2 sentences) + state your position (1 sentence). Never start with 'Je vais parler de...' — start with the context! Example: 'Le bilinguisme au Québec est un sujet qui suscite de nombreux débats. À mon avis, il représente un avantage considérable pour les immigrants.'",1),
     {type:"match",prompt:"Match the essay section to its content",pairs:[["Introduction","présenter le sujet + position"],["Paragraphe 1","premier argument + exemple concret"],["Paragraphe 2","deuxième argument + exemple"],["Paragraphe 3","nuance ou contre-argument"],["Conclusion","résumé + recommandation"]],explain:"This structure works for ANY TEF Canada writing topic. Memorize it and you can organize any response in 2-3 minutes, leaving 40+ minutes for writing and revision. Structure = time efficiency = better score.",diff:2},
     {type:"fill",before:"",blank:"___",after:"conclusion, il est évident que l'apprentissage du français enrichit considérablement la vie des immigrants au Québec.",options:["En","Pour","Dans la","À la"],correct:0,explain:"En conclusion = in conclusion. This formal connector signals your final paragraph to the evaluator. En conclusion + résumé de vos arguments + perspective/recommandation = perfect conclusion formula. Never end abruptly — En conclusion shows you planned your writing!",diff:1},
     mcq("Which transition correctly introduces a counter-argument in a B1 essay?",["Et aussi","Cependant, certains pourraient arguer que...","Mais non","Et puis"],1,"Cependant, certains pourraient arguer que = However, some might argue that. This introduces a counter-argument while using the conditionnel (pourraient = might) for appropriate nuance. Acknowledging opposing views and refuting them shows critical thinking — valued at CLB 5+!",2),
     {type:"scene",story:"TEF Canada writing prompt: 'Selon vous, est-il important d'apprendre le français au Québec? Justifiez votre réponse.' Here is a CLB 5 model introduction and first paragraph: 'Le Québec est une province dont la langue officielle est le français. Pour les immigrants qui s'y installent, l'apprentissage du français est, à mon avis, non seulement important mais essentiel. En premier lieu, maîtriser le français ouvre des portes professionnelles. En effet, la plupart des employeurs québécois exigent une connaissance du français pour accéder à des postes de qualité.'",prompt:"What B1 writing elements are present in this sample?",options:["Context (Quebec's official language), position (essential), first argument (professional doors), example (employers' requirements) — complete CLB 5 structure","Just an introduction with no argument","Only personal opinion with no structure","A conclusion with no supporting arguments"],correct:0,explain:"This model response has all CLB 5 elements: contextualization (Québec, langue française), clear position (à mon avis, essentiel), first argument introduced with en premier lieu, example (employeurs québécois). This paragraph alone would score CLB 5 in writing. Two more paragraphs + conclusion = complete response.",diff:2},
     {type:"order",prompt:"Build a conclusion: In conclusion, it is clear that French is essential for integration in Quebec",words:["En","conclusion,","il","est","évident","que","le","français","est","essentiel","à","l'intégration","au","Québec"],answer:["En","conclusion,","il","est","évident","que","le","français","est","essentiel","à","l'intégration","au","Québec"],explain:"En conclusion, il est évident que le français est essentiel à l'intégration au Québec — a strong concluding sentence. Il est évident que = it is clear that. À l'intégration = to/for integration. This conclusion is direct, uses formal vocabulary, and clearly supports the essay's position.",diff:2},
     wr("Write a complete 200-word response to: 'Quels sont les avantages d'apprendre le français pour les immigrants au Québec?'",["en premier lieu","de plus","cependant","en conclusion","à mon avis","il est vrai que","grâce à","par conséquent"],"This IS a TEF Canada writing task! Use the structure: Introduction (2-3 sentences with position) + 2 paragraphs (argument + example each) + Conclusion (summary + perspective). Count your words — aim for 200-250. Time yourself — aim for 45 minutes maximum. This practice is direct exam preparation.",3)]),

  mkL("b1-04","The Plus-Que-Parfait — Events Before Events",25,"writing",
    "The plus-que-parfait (pluperfect) describes actions that happened BEFORE another past event. 'When I arrived, he had already left.' It's essential for complex storytelling, writing about your immigration journey, explaining work history, and TEF Canada writing tasks that require past narrative. Today you master this B1 tense.",
    ["Formation: avoir/être à l'imparfait + participe passé","j'avais mangé = I had eaten","elle était partie = she had left","nous avions travaillé = we had worked","ils s'étaient rencontrés = they had met","Quand je suis arrivé, il était déjà parti = When I arrived, he had already left","Après qu'il avait fini = After he had finished","Je ne savais pas qu'il avait démissionné = I didn't know he had resigned","Contrast: PC (completed action) vs PQP (action before that action)","Déjà = already (common with PQP)"],
    [mcq("'Quand j'ai trouvé un appartement, j'___ déjà signé un bail.' Which tense?",["avais","ai","avait","aurais"],0,"J'avais déjà signé = I had already signed (plus-que-parfait). Déjà (already) is a signal word for PQP. Finding the apartment = passé composé. Signing the lease = before that, so PQP. Quand + PC → PQP describes what happened before the main past event.",1),
     mcq("Why is plus-que-parfait important for discussing immigration history?",["It's not important for immigration stories","It allows you to sequence past events: what you did BEFORE arriving, before getting your job, before getting CLB certification","It replaces passé composé","It's only for formal writing"],1,"Immigration stories naturally involve sequences of past events: 'Before I arrived, I had studied French. When I found my job, I had already obtained my CLB certification.' PQP makes these sequences clear and professional. Your immigration story in PQP = B1 French mastery.",1),
     {type:"match",prompt:"Match the sentence to the tense pair used",pairs:[["Quand je suis arrivé, il était déjà parti","PC + PQP (sequence)"],["Je ne savais pas qu'il avait démissionné","IMP + PQP (discovery)"],["Elle avait étudié avant de passer l'examen","PQP (before exam)"],["Ils s'étaient rencontrés au Québec","PQP (reflexive)"],["Après qu'elle avait fini, elle est sortie","PQP + PC (after/then)"]],explain:"PQP appears in 3 main patterns: (1) Quand/Lorsque + PC → PQP for what happened before, (2) IMP of discovery verb + PQP for what someone didn't know, (3) Après que + PQP for sequencing. Recognizing these patterns means you can use PQP automatically!",diff:3},
     {type:"fill",before:"Quand j'ai reçu ma résidence permanente, j'",blank:"___",after:"déjà trois ans au Canada.",options:["avais passé","ai passé","avais passer","aurais passé"],correct:0,explain:"J'avais passé = I had spent (plus-que-parfait of passer). Quand j'ai reçu (PC) ma résidence permanente, j'avais déjà passé trois ans (PQP) au Canada. Déjà confirms PQP. This is a real sentence many immigrants say with pride — and now you can say it grammatically correctly!",diff:2},
     mcq("'Je ne savais pas qu'ils avaient fermé le bureau.' What happened?",["The office will close","I know the office is closed","I didn't know the office had already closed (before I found out)","The office was closing as I arrived"],2,"Je ne savais pas (IMP = I didn't know) + qu'ils avaient fermé (PQP = they had already closed). This PQP pattern describes discovering information about something that had already happened. Very common in Quebec workplace and bureaucracy contexts!",2),
     {type:"scene",story:"Ravi tells his immigration consultant about his journey: 'Quand j'ai finalement obtenu mon visa, j'avais déjà étudié le français pendant deux ans. Avant de quitter l'Inde, j'avais passé le TEF et obtenu CLB 6. Quand je suis arrivé à Montréal, j'avais déjà trouvé un logement grâce à des contacts. Je ne savais pas que la vie québécoise serait si différente de ce que j'avais imaginé.'",prompt:"How many plus-que-parfait forms does Ravi use in his immigration story?",options:["4 PQP forms: avais étudié, avais passé/obtenu, avais trouvé, avais imaginé","2 PQP forms","1 PQP form","No PQP — all passé composé"],correct:0,explain:"Ravi uses PQP 4 times to sequence his immigration journey: avais étudié (before visa), avais passé/obtenu (before leaving India), avais trouvé (before arriving), avais imaginé (before arriving). This elegant narrative structure demonstrates B1 mastery — telling a complex story with proper tense sequencing!",diff:3},
     {type:"order",prompt:"Build: When I arrived in Canada I had already studied French for two years",words:["Quand","je","suis","arrivé","au","Canada,","j'avais","déjà","étudié","le","français","pendant","deux","ans"],answer:["Quand","je","suis","arrivé","au","Canada,","j'avais","déjà","étudié","le","français","pendant","deux","ans"],explain:"Quand je suis arrivé (PC) au Canada, j'avais déjà étudié (PQP) le français pendant deux ans — a sentence of genuine B1 sophistication. Pendant deux ans shows duration. Déjà reinforces the 'before' meaning. This sentence, said naturally, marks you as a B1+ French speaker.",diff:3},
     wr("Write 3 sentences about what you had done BEFORE arriving in Canada or starting your current job",["avant d'arriver","quand je suis arrivé","j'avais déjà","il avait","nous avions","elle avait","avant de commencer"],"The plus-que-parfait transforms your immigration narrative from a simple list of events into a sophisticated, chronologically nuanced story. Write your own timeline in PQP — it's also excellent CLB writing test preparation. Past events before other past events = PQP. It's that simple!",3)]),

  mkL("b1-05","Dont & Lequel — Advanced Relative Clauses",25,"writing",
    "You mastered qui, que, and où. Now it's time for the advanced relative pronouns: dont and lequel/laquelle/lesquels/lesquelles. Dont replaces de + noun. Lequel replaces preposition + thing. These appear constantly in formal writing, official documents, and TEF Canada reading passages. Today you unlock the final layer of French relative clauses.",
    ["dont = of which/whose/about which (replaces de + noun)","L'emploi dont je rêve = The job I dream of (rêver de)","La personne dont je parle = The person I'm talking about","Lequel/laquelle = which (after prepositions other than de)","La raison pour laquelle = The reason for which/why","Le bureau dans lequel = The office in which","L'outil grâce auquel = The tool thanks to which","Auquel = à + lequel (contracted)","Duquel = de + lequel (contracted)","Ce dont j'ai besoin = What I need (ce dont)"],
    [mcq("'C'est le poste ___ je rêvais depuis des années.' Which relative pronoun?",["que","qui","dont","où"],2,"Dont because rêver takes de: rêver de quelque chose. C'est le poste dont je rêvais = It's the job I had been dreaming of. Any verb that takes de requires dont as relative pronoun: avoir besoin de → dont j'ai besoin, parler de → dont je parle, se souvenir de → dont je me souviens.",1),
     mcq("'La raison ___ j'ai quitté mon pays est économique.' Which relative pronoun?",["que","dont","pour laquelle","où"],2,"Pour laquelle because the construction is: la raison pour laquelle = the reason for which. Lequel/laquelle agrees in gender with the noun it replaces: la raison (feminine) → pour laquelle. This phrase appears constantly in interviews and formal writing!",2),
     {type:"match",prompt:"Match the sentence to the correct relative pronoun",pairs:[["La ville ___ il parle est Montréal (parler de)","dont"],["Le bureau ___ je travaille est moderne (dans)","dans lequel"],["C'est ce ___ j'ai besoin (avoir besoin de)","dont"],["L'outil ___ nous nous servons (se servir de)","dont"],["La raison ___ il a démissionné (pour)","pour laquelle"]],explain:"Dont = replaces de + any noun/pronoun. Lequel/laquelle = replaces other preposition + thing (not person). Ce dont = what (+ de verb). These patterns cover 95% of advanced relative clause usage. Master them and your French writing reaches C1 level sophistication!",diff:3},
     {type:"fill",before:"Le programme",blank:"___",after:"je me suis inscrit m'a beaucoup aidé. (The program I enrolled in helped me a lot.)",options:["auquel","duquel","dont","lequel"],correct:0,explain:"S'inscrire à + programme = à + lequel = auquel. Le programme auquel je me suis inscrit = The program I enrolled in. Auquel is the contraction of à + lequel. This appears in university applications, immigration documents, and professional correspondence constantly!",diff:3},
     mcq("'Ce dont vous avez besoin, c'est de la pratique.' What does 'ce dont' mean here?",["That which","What (= the thing of which)","Which","Who"],1,"Ce dont = what (the thing of which). Ce dont vous avez besoin = what you need (avoir besoin de → dont). Ce + dont creates a nominal relative clause. Ce dont j'ai besoin, ce dont il parle, ce dont nous sommes fiers — all follow the same pattern. Very formal and impressive!",2),
     {type:"scene",story:"In her formal cover letter, Priya writes: 'Le poste dont vous faites la description correspond exactement au profil que j'ai développé. La raison principale pour laquelle je pose ma candidature est mon désir de progresser dans un environnement francophone. C'est exactement ce dont j'ai besoin pour atteindre mes objectifs professionnels.'",prompt:"How many advanced relative pronouns does Priya use?",options:["3: dont (faire la description de), pour laquelle (la raison pour laquelle), ce dont (avoir besoin de)","1: only dont","2: dont and lequel","None — she uses basic relative clauses"],correct:0,explain:"Priya uses 3 advanced relative pronouns perfectly: dont (le poste dont vous faites la description), pour laquelle (la raison pour laquelle), ce dont (c'est ce dont j'ai besoin). This cover letter demonstrates C1 level writing. It would stand out in any Quebec application pile.",diff:3},
     {type:"order",prompt:"Build: The reason for which I chose Quebec is its quality of life",words:["La","raison","pour","laquelle","j'ai","choisi","le","Québec","est","sa","qualité","de","vie"],answer:["La","raison","pour","laquelle","j'ai","choisi","le","Québec","est","sa","qualité","de","vie"],explain:"La raison pour laquelle j'ai choisi le Québec est sa qualité de vie — a sentence of genuine B1+ sophistication. Use it in interviews, applications, and community conversations. Pour laquelle = for which (feminine to agree with raison). This sentence honors Quebec while showing advanced French!",diff:3},
     wr("Write 2 sentences using dont and pour lequel/laquelle",["dont","pour lequel","pour laquelle","auquel","ce dont","avoir besoin de","rêver de","parler de"],"Using dont and lequel/laquelle correctly places you at B1-B2 level. These pronouns appear in TEF Canada reading passages and are required for high scores in writing. Practice finding verbs that take de (rêver de, parler de, avoir besoin de, se souvenir de) — these always trigger dont!",3)]),

  mkL("b1-06","B1 Listening — Strategies for Comprehension",25,"listening",
    "CLB 5 listening means understanding extended conversations, interviews, presentations, and news reports in French. The TEF Canada listening section includes real radio excerpts, interviews, and conversations — at natural speed, with Quebec accents. Today you learn professional listening strategies that boost comprehension when you can't ask for repetition.",
    ["Anticipation: lire les questions AVANT d'écouter","Mots-clés: chercher les mots importants","Contexte: utiliser le contexte pour deviner","Synonymes: les réponses utilisent souvent des synonymes","Intonation: la prosodie donne des indices","Connecteurs: donc, mais, cependant = changements de direction","Les chiffres et les dates: noter immédiatement","Le registre: formel vs informel","Les noms propres: prêter attention aux noms de personnes/lieux","Ne pas bloquer: si vous manquez un mot, continuez"],
    [mcq("What is the MOST important TEF Canada listening strategy?",["Listen to the whole text first","Read all questions BEFORE the audio starts","Try to understand every single word","Listen multiple times"],1,"Read questions BEFORE listening! This activates your brain to listen for specific information. You know WHAT to listen for before the audio starts. In TEF Canada, you have 30-45 seconds to read questions before each audio — use every second of this preparation time.",2),
     mcq("You miss a word in the TEF Canada listening. What should you do?",["Stop the test","Go back to the beginning","Keep listening — the context will help you answer anyway","Ask the examiner"],2,"Ne jamais bloquer! = Never get stuck! Miss a word → keep going. Context, intonation, and the surrounding words usually give you enough to answer. Stopping mentally costs you the next 10 seconds of audio. Train yourself to keep listening even when uncertain.",1),
     {type:"match",prompt:"Match the listening strategy to when you use it",pairs:[["Anticipation des questions","before the audio starts"],["Chercher les mots-clés","during listening"],["Utiliser le contexte","when a word is missed"],["Noter les chiffres immédiatement","during listening"],["Synonymes dans les réponses","when choosing your answer"]],explain:"Each strategy has a moment: preparation (before), key words and note-taking (during), context and synonyms (during/after). Managing your attention across these three phases transforms your comprehension. This is exactly what professional interpreters do — and you can too!",diff:2},
     {type:"fill",before:"Dans la section d'écoute du TEF Canada, vous avez généralement",blank:"___",after:"pour lire les questions avant chaque document audio.",options:["30 à 45 secondes","5 minutes","une heure","aucun temps"],correct:0,explain:"30 à 45 secondes = 30-45 seconds to read questions before each audio in TEF Canada. This time is GOLD. Read fast, identify what information to hunt for (numbers? names? opinions? events?), and prime your brain. Never waste this preparation time!",diff:1},
     mcq("You hear 'Le taux de chômage a diminué de 2,3%'. This is a number. What should you do?",["Ignore numbers — they're not tested","Write it down immediately: 2,3%","Try to remember it mentally","Ask yourself if it's important"],1,"Écrire les chiffres immédiatement! Numbers are extremely common in TEF Canada listening questions (statistics, percentages, years, ages, amounts). Write them IMMEDIATELY on your test paper. Your working memory cannot reliably hold precise numbers while continuing to listen.",2),
     {type:"scene",story:"Before the TEF Canada listening section, the examiner says you'll hear a Radio-Canada news report about immigration in Quebec. You have 40 seconds to read 4 questions: (1) What percentage of immigrants settle in Montreal? (2) Which region wants to attract more immigrants? (3) What is the main challenge mentioned? (4) What solution does the minister propose?",prompt:"What should you do in those 40 seconds?",options:["Read questions and mentally tag what to listen for: percentage/number, region name, challenge/problem word, minister's solution/proposal","Just relax and wait for the audio","Try to predict the answers","Read only question 1"],correct:0,explain:"40 seconds = read all 4 questions + tag listening targets: (1) number/percentage, (2) region name (proper noun), (3) problem/challenge word, (4) solution/proposal word. You now know EXACTLY what to listen for. When the audio plays, your brain is already primed — comprehension jumps dramatically!",diff:2},
     {type:"order",prompt:"Name the 4 TEF Canada listening skills being tested: comprehension, vocabulary, details, main idea",words:["compréhension","globale,","vocabulaire","en","contexte,","détails","spécifiques,","idée","principale"],answer:["compréhension","globale,","vocabulaire","en","contexte,","détails","spécifiques,","idée","principale"],explain:"The 4 listening skills in TEF Canada: compréhension globale (overall understanding), vocabulaire en contexte (vocabulary from context), détails spécifiques (specific details — numbers, names, facts), idée principale (main idea). Different question types test different skills. Knowing this helps you allocate attention!",diff:1},
     wr("Describe your personal listening challenges in French and 2 strategies you'll use to improve",["j'ai du mal à","quand je","la stratégie que je vais utiliser","pour améliorer","la compréhension","l'écoute","les connecteurs","les mots-clés"],"Understanding your specific listening weaknesses is the first step to improving them. Quebec accents, fast speech, background noise, specialized vocabulary — different challenges need different strategies. Write your personalized listening improvement plan in French. This self-reflection IS B1 metacognitive skill!",2)]),

  mkL("b1-07","Advanced Vocabulary — Abstract Concepts",30,"mixed",
    "B1 French requires vocabulary beyond daily life — you need words for ideas, concepts, values, and systems. This abstract vocabulary is essential for discussions about immigration policy, workplace equality, healthcare ethics, environmental responsibility, and Quebec society. Today you learn 40 key abstract vocabulary words that unlock B1-level conversation.",
    ["la citoyenneté = citizenship","l'équité = equity/fairness","la diversité = diversity","l'intégration = integration","la solidarité = solidarity","le développement durable = sustainable development","la mondialisation = globalization","les inégalités = inequalities","la liberté d'expression = freedom of expression","la démocratie = democracy","l'inclusion = inclusion","le patrimoine = heritage","l'identité = identity","les valeurs = values","la laïcité = secularism (very Quebec-specific!)"],
    [mcq("Quebec's 'laïcité' refers to:",["A type of Quebec cheese","The strict separation of religion and state in public institutions — very specific to Quebec","A Quebec holiday","The French language in Quebec"],1,"La laïcité = secularism — the separation of religion from public/government institutions. Quebec's Loi sur la laïcité de l'État (Bill 21) prohibits certain religious symbols for public employees. This is a major social debate in Quebec. Understanding laïcité is essential for understanding Quebec society!",2),
     mcq("'Le développement durable' is mentioned in your city's new plan. This means:",["Fast development","Sustainable development (meeting present needs without compromising future generations)","Expensive development","Rural development"],1,"Développement durable = sustainable development. This vocabulary is everywhere in Quebec politics, corporate responsibility statements, and job postings. Companies in Quebec increasingly require environmental consciousness — le développement durable is a B1 essential.",1),
     {type:"match",prompt:"Match the abstract concept to its Quebec context",pairs:[["la laïcité","separation of religion from Quebec public institutions"],["l'intégration","immigrants becoming part of Quebec society"],["la diversité","variety of cultures and backgrounds in Quebec"],["les inégalités","economic or social gaps in Quebec"],["le patrimoine","Quebec's cultural and historical heritage"]],explain:"These 5 abstract concepts are central to Quebec social discourse. They appear in news, political debates, workplace discussions, and TEF Canada texts. Understanding them means you can participate meaningfully in Quebec society — not just functionally, but intellectually.",diff:2},
     {type:"fill",before:"Au Québec,",blank:"___",after:"culturelle est considérée comme une richesse qui contribue à l'identité de la province.",options:["la diversité","la laïcité","la solidarité","la mondialisation"],correct:0,explain:"La diversité culturelle = cultural diversity. Au Québec, la diversité culturelle est considérée comme une richesse = In Quebec, cultural diversity is considered a richness. This is the official Quebec government position. Knowing this vocabulary lets you engage in genuine conversations about your role in Quebec society.",diff:2},
     mcq("Your employer's annual report mentions 'les valeurs d'équité et d'inclusion'. This means:",["The company values equity and inclusion","The company values equality and exclusion","The company discusses only financial values","The company requires religious values"],0,"L'équité = equity/fairness. L'inclusion = inclusion. These are core values appearing in most major Quebec companies' policies. Equité differs from égalité: égalité = everyone gets the same; équité = everyone gets what they need. Important distinction in Quebec workplace discussions!",2),
     {type:"scene",story:"During a Quebec citizenship ceremony, the judge says: 'Vous devenez aujourd'hui citoyens d'un pays fondé sur des valeurs de démocratie, de diversité et de liberté d'expression. Le Québec accueille sa richesse de la pluralité de ses habitants. Votre intégration enrichit notre identité collective et renforce notre solidarité comme peuple.'",prompt:"How many abstract B1 vocabulary words appear in this citizenship speech?",options:["6+ concepts: valeurs, démocratie, diversité, liberté d'expression, intégration, identité, solidarité","2 concepts","4 concepts","No abstract vocabulary"],correct:0,explain:"The citizenship speech contains 7 abstract concepts: valeurs (values), démocratie (democracy), diversité (diversity), liberté d'expression (freedom of expression), intégration (integration), identité (identity), solidarité (solidarity). Understanding this speech means you truly understand Quebec's foundational values — essential for citizenship!",diff:2},
     {type:"order",prompt:"Express: Cultural diversity is a strength of Quebec society",words:["La","diversité","culturelle","est","une","force","de","la","société","québécoise"],answer:["La","diversité","culturelle","est","une","force","de","la","société","québécoise"],explain:"La diversité culturelle est une force de la société québécoise — a statement you can make with pride as an immigrant in Quebec. Force = strength. La société québécoise = Quebec society. This sentence, said genuinely, opens conversations and builds bridges. Abstract vocabulary = the ability to engage with ideas, not just things.",diff:2},
     wr("Write your perspective on one Quebec social value (diversité, équité, laïcité, intégration) in 3-4 sentences",["à mon avis","cette valeur","représente","contribue à","il est important que","je crois que","la société québécoise","pour moi"],"Engaging with Quebec's abstract social values in French shows you've moved beyond functional communication to genuine intellectual participation. This type of reflection is tested directly in TEF Canada writing and speaking sections. More importantly, it's how you contribute to your community!",3)]),

  mkL("b1-08","Gerund — En + Participe Présent",20,"writing",
    "The gerund (gérondif) — en + present participle — is a uniquely French structure expressing simultaneous actions or manner. 'While working in Montreal...', 'By speaking French...', 'Upon arriving in Canada...' — it's elegant, concise, and marks B1+ speakers. Today you master this structure for sophisticated expression.",
    ["Gérondif = en + participe présent","Participe présent: radical + -ant","parler → parlant → en parlant = while speaking","travailler → travaillant → en travaillant = while working","faire → faisant → en faisant = while doing","Irregular: être → étant, avoir → ayant, savoir → sachant","En arrivant au Canada = Upon arriving in Canada","En travaillant dur = By working hard","Il a appris en écoutant = He learned by listening","Condition: En suivant ces conseils = By following this advice"],
    [mcq("'En suivant des cours de français, j'ai progressé rapidement.' What does this mean?",["I progressed rapidly before taking French classes","By taking French classes, I progressed rapidly","I took French classes after progressing","After classes, I may progress"],1,"En + gérondif = by doing something. En suivant des cours = by taking classes. The gerund expresses the MEANS/METHOD. This sentence is perfect for interviews: 'Comment avez-vous appris le français?' → 'En suivant des cours et en pratiquant quotidiennement.'",1),
     mcq("How do you form the participe présent of 'travailler'?",["travaillé","travaillant","travaillerait","travaillez"],1,"Participe présent: nous-form of présent → drop -ons → add -ant. Travailler: nous travaillons → travaillons → travaillant. En travaillant = while working / by working. The exceptions: être → étant, avoir → ayant, savoir → sachant — these must be memorized!",1),
     {type:"match",prompt:"Match the gerund to its English meaning",pairs:[["en parlant","while speaking / by speaking"],["en arrivant","upon arriving / when arriving"],["en faisant","while doing / by doing"],["en étant","while being / by being"],["en sachant","knowing / by knowing"]],explain:"These 5 gerunds cover the most common usage patterns. Timing (en arrivant = upon arriving), manner (en parlant doucement = speaking gently), condition (en sachant cela = knowing this), means (en travaillant = by working). Master these and your French gains an elegant sophistication.",diff:2},
     {type:"fill",before:"J'ai appris à naviguer les systèmes québécois",blank:"___",after:"des questions et en cherchant de l'information.",options:["en posant","en pose","posant","de poser"],correct:0,explain:"En posant (des questions) = by asking (questions). Two gerunds connected with et: en posant des questions et en cherchant de l'information = by asking questions and by searching for information. The gerund with et allows elegant listing of simultaneous or sequential methods. Very natural in French!",diff:2},
     mcq("'Il a réussi son entrevue en préparant soigneusement.' What helped him succeed?",["He succeeded despite careless preparation","He succeeded because he prepared carefully","He succeeded without preparation","He will succeed if he prepares"],1,"En préparant soigneusement = by preparing carefully. The gerund expresses how he succeeded — the method. Soigneusement = carefully. This cause-and-effect structure is perfect for discussing professional success: 'Comment avez-vous réussi?' → 'En travaillant dur et en me préparant.'",1),
     {type:"scene",story:"In her TEF Canada oral test, Sara explains her language learning journey: 'En arrivant au Québec, j'ai réalisé l'importance du français. En suivant des cours à l'école de langue, j'ai amélioré ma grammaire. En regardant des émissions québécoises et en parlant avec mes voisins, j'ai appris le québécois authentique. En persistant malgré les difficultés, j'ai atteint le niveau B1.'",prompt:"How many gerunds does Sara use and what does each express?",options:["4 gerunds: arrivant (timing), suivant (method), regardant/parlant (simultaneous methods), persistant (condition for success)","2 gerunds","1 gerund","No gerunds — she uses infinitives"],correct:0,explain:"Sara uses 4 gerunds (+ 1 extra with et): en arrivant (timing - upon arriving), en suivant (method - by taking), en regardant + en parlant (simultaneous methods - by watching and speaking), en persistant (means - by persisting). This response demonstrates B1 sophistication and would score well in TEF Canada oral!",diff:3},
     {type:"order",prompt:"Build: By working hard and by studying every day I improved my French",words:["En","travaillant","dur","et","en","étudiant","chaque","jour,","j'ai","amélioré","mon","français"],answer:["En","travaillant","dur","et","en","étudiant","chaque","jour,","j'ai","amélioré","mon","français"],explain:"En travaillant dur et en étudiant chaque jour, j'ai amélioré mon français — two gerunds connected with et. This is your language learning testimony in perfect B1 French! The gerund elegantly expresses the relationship between effort and result. Say this in your next TEF Canada practice session.",diff:2},
     wr("Write 3 sentences using gerunds to describe how you are adapting to life in Quebec",["en arrivant","en apprenant","en parlant","en travaillant","en cherchant","en suivant","en persistant"],"Three gerund sentences about Quebec adaptation = a mini TEF Canada oral response! Practice saying them aloud. The gerund gives your French an elegant, native-like quality that distinguishes B1 speakers. En persistant, vous réussirez — and that is a promise!",2)]),

  mkL("b1-09","TEF Canada — Speaking Test Preparation",35,"speaking",
    "The TEF Canada expression orale section is 35 minutes with 3 tasks. Today you prepare for each task type with real practice strategies. Task 1: monologue (personal topic, 1-3 minutes). Task 2: interactive exercise (role-play). Task 3: guided conversation (opinion, debate). Each task has specific strategies that maximize your CLB score.",
    ["Tâche 1: monologue de 1-3 minutes (sujet personnel)","Tâche 2: jeu de rôle interactif avec l'évaluateur","Tâche 3: conversation guidée + opinion","Critères d'évaluation: interaction, cohérence, vocabulaire, grammaire, prononciation","Visez CLB 5: 250+ mots, 2+ minutes, structures variées","Stratégies: ne pas mémoriser, structurer mentalement","Débuter: 'Pour répondre à cette question...'","Conclure: 'En conclusion, je pense que...'","Si silence: 'Laissez-moi réfléchir un instant...'","Erreur? Autocorrection: 'Pardon, je veux dire...'"],
    [mcq("TEF Canada Task 1 (monologue): What should you NOT do?",["Structure your response (intro + points + conclusion)","Memorize a script word for word — you'll sound unnatural and lose points","Use examples from your personal experience","Speak for at least 90 seconds"],1,"Ne jamais mémoriser un script! Evaluators immediately detect memorized responses and score them lower — they lack natural spontaneity. Instead: memorize the STRUCTURE (intro + 2-3 points + conclusion), prepare key vocabulary, and speak naturally. Authenticity scores better than perfection!",2),
     mcq("In TEF Task 3 (guided conversation/debate), how do you score highest?",["Agree with everything the evaluator says","Express a clear opinion, back it with 2 reasons, acknowledge the other side","Only ask questions","Speak as fast as possible"],1,"Express opinion + 2 reasons + acknowledge opposing view = maximum score. This structure shows: opinion expression, argument development, and nuanced thinking — all CLB 5 criteria. Use: À mon avis... En premier lieu... De plus... Cependant, certains diraient... Néanmoins, je reste convaincu(e) que...",2),
     {type:"match",prompt:"Match the TEF speaking task to its preparation strategy",pairs:[["Tâche 1 (monologue)","prepare 3 personal examples for any topic"],["Tâche 2 (jeu de rôle)","practice common scenarios: complaint, request, negotiation"],["Tâche 3 (conversation/opinion)","prepare opinion structures + topic vocabulary"],["Self-correction","'Pardon, je veux dire...' or 'Ce que je voulais dire, c'est...'"],["Silence management","'Laissez-moi réfléchir un instant...' or 'C'est une bonne question...'"]],explain:"Each task has specific preparation. Monologue: personal examples ready. Roleplay: scenario vocabulary. Opinion: debate structures. These specific preparations mean no task surprises you on test day. You've practiced every type — confidence follows!",diff:2},
     {type:"fill",before:"Si je fais une erreur pendant le test, je dois dire:",blank:"___",after:"je veux dire... et continuer.",options:["Pardon,","Excusez-moi,","Oh non,","Arrêtez,"],correct:0,explain:"Pardon, je veux dire... = Sorry, I mean... This natural self-correction shows metacognitive awareness — you caught your own error and fixed it. Evaluators REWARD self-correction — it shows you know the correct form. Never stop talking to correct: correct on the fly and continue!",diff:1},
     mcq("How long should your Task 1 monologue ideally be for CLB 5?",["30-60 seconds","60-90 seconds","90 seconds to 2.5 minutes","5+ minutes"],2,"90 seconds to 2.5 minutes (ideally 2 minutes) for CLB 5. Too short = insufficient. Too long = potential point penalties for rambling. Structure: 20-30 second introduction + 3 × 30-40 second points + 20 second conclusion = approximately 2 minutes. Time your practice!",2),
     {type:"scene",story:"TEF Task 3 prompt: 'Pensez-vous que le gouvernement devrait rendre les cours de français obligatoires pour tous les immigrants?' Amara's response structure: '(Intro+position) À mon avis, oui. (Point 1) En premier lieu, le français est essentiel à l'intégration. (Point 2) De plus, cela favorise l'accès à l'emploi. (Nuance) Cependant, les modalités doivent être flexibles. (Conclusion) En définitive, je reste convaincue que ces cours sont nécessaires.' Time: 1 min 45 sec.",prompt:"Did Amara structure her response correctly for CLB 5?",options:["Yes — clear position, 2 arguments, nuance, conclusion, appropriate length (1min45)","No — too short","No — no opinion expressed","No — too many arguments"],correct:0,explain:"Amara's structure is perfect for CLB 5: à mon avis (opinion), en premier lieu + de plus (2 arguments), cependant (nuance), en définitive (conclusion). 1min45 is within the ideal range. She would score CLB 5-6 on this task. This is the template — memorize it and personalize it!",diff:2},
     {type:"order",prompt:"Build the ideal Task 3 structure in French",words:["À","mon","avis...","En","premier","lieu...","De","plus...","Cependant...","En","conclusion,","je","reste","convaincu(e)"],answer:["À","mon","avis...","En","premier","lieu...","De","plus...","Cependant...","En","conclusion,","je","reste","convaincu(e)"],explain:"À mon avis... En premier lieu... De plus... Cependant... En conclusion, je reste convaincu(e) — the 5-part CLB 5 opinion template! Memorize this sequence. For ANY opinion topic in TEF Task 3, this structure guarantees a well-organized response. The evaluator SEES the structure and scores it positively.",diff:2},
     wr("Practice Task 1: Write a 150-200 word monologue about why you came to Quebec",["pour répondre à cette question","je suis venu(e) au Québec","en premier lieu","de plus","c'est pourquoi","en conclusion","grâce à"],"Write this response, then say it aloud and time yourself. Aim for 1min30 to 2min30. Record yourself — listen for: structure (clear?), vocabulary variety (repetition?), fluency (natural?), opinion expression (present?). This practice IS the TEF Canada preparation. Every time you do it, you improve.",3)]),

  mkL("b1-10","TEF Canada — Writing Test Mastery",35,"writing",
    "The TEF Canada expression écrite section gives you 60 minutes for 2 writing tasks. Task 1: short text (email/message, ~80 words, CLB 4-5). Task 2: longer text (opinion/argument, ~200 words, CLB 5-6). Today you practice both tasks with real TEF-style prompts and learn the exact strategies that maximize your writing score.",
    ["Tâche 1: 80-100 mots, email/lettre/message informel ou semi-formel","Tâche 2: 180-220 mots, texte argumenté (pour/contre, opinion)","Planification: 5-7 minutes pour structurer","Rédaction: 35-40 minutes pour écrire","Révision: 10-15 minutes pour corriger","Critères: accomplissement de la tâche, cohérence, vocabulaire, grammaire","Tâche 1 erreur courante: trop court ou hors sujet","Tâche 2 erreur courante: pas de structure, pas d'exemples","Relecture: chercher accord, conjugaison, orthographe","Connecteurs: toujours inclure au moins 5 connecteurs différents"],
    [mcq("TEF Canada Task 1 (short email): What is the most common mistake?",["Writing too much","Writing off-topic OR too short (under 60 words)","Using formal language","Having grammar errors"],1,"Hors sujet (off-topic) or trop court = major penalties. Task 1 gives specific instructions (e.g., 'Write an email to your neighbour about...'). EVERY required element must be in your text. Before writing: identify all required elements → check each one is included → verify word count.",2),
     mcq("For TEF Task 2 (200-word argument), what is the minimum number of paragraphs?",["1 paragraph","2 paragraphs (no structure)","4 paragraphs: introduction + 2 body + conclusion","As many as you want"],2,"4 paragraphs: introduction (position) + argument 1 (with example) + argument 2 (with nuance) + conclusion (recommendation/summary). This structure signals organization to evaluators and guarantees you cover all aspects of the task. 4 paragraphs for CLB 5 = professional writing standard.",1),
     {type:"match",prompt:"Match the TEF writing step to its time allocation (60 min total)",pairs:[["Lire la consigne (read instructions)","2-3 minutes"],["Planifier votre réponse","5-7 minutes"],["Rédiger le texte","35-40 minutes"],["Réviser et corriger","10-15 minutes"],["Vérifier le nombre de mots","1-2 minutes"]],explain:"Time management is critical. Many candidates run out of time during TEF writing. Practice this 60-minute breakdown: read (3) + plan (7) + write (40) + revise (10). Revision is NOT optional — 5-10 minutes of correction catches errors that cost points. Build this rhythm now.",diff:2},
     {type:"fill",before:"Pour la tâche 2, vous devez écrire entre",blank:"___",after:"mots pour obtenir CLB 5.",options:["180 et 220","50 et 100","100 et 150","250 et 300"],correct:0,explain:"180-220 words is the target for TEF Task 2 at CLB 5. Under 150 = insufficient development → score drops. Over 250 = risk of off-topic expansion and time loss. Count as you write: mark every 50 words. This habit saves your TEF writing score.",diff:1},
     mcq("After writing your Task 2, what should you check FIRST during revision?",["Spelling of every word","Verb agreement and subject-verb agreement — most frequent errors","Punctuation only","Word count only"],1,"Subject-verb agreement and verb tense agreement = most frequent error type in TEF writing. Check: every verb → correct conjugation? Every subject → correct agreement? Then: adjective agreement, then spelling, then connectors. This systematic revision catches errors that automatic spell-checkers miss.",2),
     {type:"scene",story:"TEF Task 1 prompt: 'Vous avez commandé un appareil électronique en ligne. Il est arrivé endommagé. Écrivez un email au service client pour expliquer le problème et demander un remboursement ou un échange. (80-100 mots)' A model response: 'Objet: Appareil endommagé — commande n°45892. Bonjour, Je vous contacte suite à ma commande du 15 avril. Malheureusement, l'appareil reçu est endommagé: l'écran est fissuré. Je joins des photos en preuve. Je souhaiterais soit un remboursement complet, soit un échange immédiat. Dans l'attente de votre réponse rapide, je vous adresse mes meilleures salutations. Ravi Sharma' [93 words]",prompt:"Does this Task 1 response meet all TEF requirements?",options:["Yes: includes the problem (damaged screen), evidence mention (photos), solution request (refund or exchange), appropriate format, 93 words — perfect!","No: too informal","No: too long","No: missing required elements"],correct:0,explain:"This response is TEF perfect: object line (Objet), formal opening (Bonjour), explains problem (endommagé, écran fissuré), provides evidence (photos en preuve), requests solution (remboursement ou échange), formal closing (meilleures salutations), 93 words. Every required element present. This is the CLB 5 standard!",diff:2},
     {type:"order",prompt:"Build a TEF Task 1 opening: Following my order of April 15th I am contacting you because...",words:["Suite","à","ma","commande","du","15","avril,","je","vous","contacte","car..."],answer:["Suite","à","ma","commande","du","15","avril,","je","vous","contacte","car..."],explain:"Suite à ma commande du 15 avril, je vous contacte car... — this formal email opening immediately establishes context (suite à = following) and purpose (je vous contacte car = I'm contacting you because). It's professional, clear, and would earn full marks in TEF Task 1. Use this template for any complaint or request email!",diff:2},
     wr("Write a complete 200-word TEF Task 2 on: 'Selon vous, est-il nécessaire d'apprendre la culture québécoise pour bien s'intégrer?'",["à mon avis","en premier lieu","de plus","cependant","en conclusion","il est vrai que","grâce à","par conséquent","il est important que"],"This is a real TEF Canada writing task. Time yourself: 7 min planning + 38 min writing + 10 min revision = 55 min. Count your words. Use at least 5 connectors. Check subject-verb agreement in revision. This complete practice session is your most valuable TEF preparation. Faites-le maintenant!",3)]),

  mkL("b1-11","Complex Sentences — Expressing Conditions",25,"writing",
    "Conditional sentences ('If you do X, Y will happen') are essential for professional French — negotiating, problem-solving, advising, and predicting. French has three conditional structures that English-speaking learners often confuse. Today you master all three so you can express nuance, hypotheticals, and advice with sophistication.",
    ["Si + présent → futur simple (real condition)","Si tu travailles dur, tu réussiras = If you work hard, you will succeed","Si + imparfait → conditionnel présent (hypothetical)","Si j'avais plus de temps, j'étudierais davantage = If I had more time, I'd study more","Si + plus-que-parfait → conditionnel passé (impossible past)","Si j'avais su, j'aurais préparé mieux = If I had known, I would have prepared better","À condition que + subjonctif = On the condition that","Pourvu que + subjonctif = Provided that","Sauf si = Unless","En cas de = In case of"],
    [mcq("'Si vous maîtrisez le français, ___ de meilleures opportunités.' Real condition. Which form?",["vous auriez","vous aurez","vous avez","vous aviez"],1,"Si + présent (maîtrisez) → futur (vous aurez). Real/possible condition. This is the most optimistic structure: if this is realistic, this will happen. Si vous maîtrisez le français, vous aurez de meilleures opportunités = If you master French, you will have better opportunities. True for every immigrant in Quebec!",1),
     mcq("'Si j'___ plus de temps libre, j'apprendrais le français plus vite.' Hypothetical condition:",["ai","aurai","avais","aurais"],2,"Si + imparfait (avais) → conditionnel (apprendrais). Hypothetical — currently not true. Si j'avais plus de temps = if I had more time (but I don't). Very common for discussing improvements: 'Si le gouvernement investissait davantage, l'intégration serait meilleure.'",1),
     {type:"match",prompt:"Match the condition type to its structure",pairs:[["Real/possible condition","si + présent → futur"],["Hypothetical condition","si + imparfait → conditionnel"],["Impossible past condition","si + plus-que-parfait → conditionnel passé"],["On the condition that","à condition que + subjonctif"],["Unless","sauf si + indicatif"]],explain:"Three conditional types — three different structures. Real (optimistic, possible), hypothetical (currently not true but imaginable), impossible past (regret or speculation about the past). Using all three shows genuine B1+ mastery. TEF Canada writing often requires conditional structures!",diff:2},
     {type:"fill",before:"Si j'avais su que le marché immobilier québécois était si compétitif, j'",blank:"___",after:"un appartement dès mon arrivée.",options:["aurais réservé","réserverais","réservais","aurais réservation"],correct:0,explain:"Si + PQP (avais su) → conditionnel passé (aurais réservé). Impossible past condition — regret about what didn't happen. J'aurais réservé = I would have reserved. This structure expresses regret and learning from experience — valuable for interviews: 'Si j'avais su, j'aurais fait... À l'avenir, je ferai...'",diff:3},
     mcq("Your employer offers a raise: 'Nous augmenterons votre salaire à condition que vous obteniez votre CLB 5.' What must you do?",["Nothing — the raise is guaranteed","Get CLB 5 certification — that's the condition for the raise","Ask for more money","Wait for further instructions"],1,"À condition que + subjonctif = on the condition that. Vous augmenterons = we will increase. À condition que vous obteniez CLB 5 = on the condition that you obtain CLB 5. This is a real workplace conditional — your employer is telling you exactly what is needed for a raise. CLB 5 = more money!",2),
     {type:"scene",story:"Ravi is negotiating his salary: 'Si vous m'accordez cette augmentation, je m'engage à obtenir CLB 6 d'ici six mois. Si j'avais su plus tôt que le français était si valorisé, j'aurais commencé mes études linguistiques avant d'arriver. À l'avenir, à condition que l'entreprise soutienne ma formation, je pourrais atteindre le niveau B2 en un an.'",prompt:"How many conditional structures does Ravi use?",options:["3: si+présent→futur (real condition), si+PQP→conditionnel passé (impossible past), à condition que+subjonctif","1: only si+présent","2: real and hypothetical","No conditionals"],correct:0,explain:"Ravi uses all 3 conditional types! Si vous m'accordez → j'engage (real, present→future), Si j'avais su → j'aurais commencé (impossible past, PQP→conditionnel passé), à condition que l'entreprise soutienne (à condition que + subjonctif). This salary negotiation in French is B1 mastery in action!",diff:3},
     {type:"order",prompt:"Build: If I had known about Quebec's language requirements I would have prepared earlier",words:["Si","j'avais","su","les","exigences","linguistiques","du","Québec,","je","me","serais","préparé(e)","plus","tôt"],answer:["Si","j'avais","su","les","exigences","linguistiques","du","Québec,","je","me","serais","préparé(e)","plus","tôt"],explain:"Si j'avais su (PQP) les exigences linguistiques du Québec, je me serais préparé(e) (conditionnel passé) plus tôt — the impossible past conditional expressing a regret. Me serais préparé(e) = would have prepared (myself — reflexive). This structure is perfect for reflecting on your immigration journey with sophistication.",diff:3},
     wr("Write 3 conditional sentences about your life in Quebec using all 3 types (real, hypothetical, impossible past)",["si + présent → futur","si + imparfait → conditionnel","si + plus-que-parfait → conditionnel passé","à condition que","pourvu que"],"Three conditional types demonstrate genuine B1 grammatical range. TEF Canada writing tasks frequently require conditional reasoning. Write one of each: your realistic goal, an imaginary scenario, and a past reflection. This grammatical variety directly boosts your writing score!",3)]),

  mkL("b1-12","Quebec in Canada — Civic Knowledge",25,"mixed",
    "Understanding Quebec's place in Canada — the political system, language laws, historical context, and current debates — makes you a more informed and confident resident. This knowledge appears in CLB reading tests, citizenship exams, and real conversations. Today you learn the essential civic vocabulary and knowledge for Quebec life.",
    ["La Charte de la langue française (Loi 101) = French Language Charter","l'Assemblée nationale = Quebec's legislature (like a parliament)","le premier ministre du Québec = Quebec's Premier","le gouvernement fédéral = the federal government","la Constitution = the Constitution","les droits et libertés = rights and freedoms","la Commission des droits de la personne = Human Rights Commission","la dualité linguistique = linguistic duality (Canada's two official languages)","les peuples autochtones = Indigenous peoples","le référendum = referendum (1980 and 1995 on Quebec sovereignty)"],
    [mcq("La Loi 101 (Charte de la langue française) does what?",["Makes English the official language of Quebec","Establishes French as the official language of Quebec and regulates its use in work, education, and commerce","Prohibits the use of English in Quebec","Requires all immigrants to speak French immediately"],1,"La Loi 101 = the French Language Charter. It establishes French as Quebec's sole official language and requires French in the workplace, schools (for most children), and public signage. Understanding this law explains many aspects of Quebec life — why stores must serve you in French, why signs are in French first.",1),
     mcq("What is l'Assemblée nationale du Québec?",["The federal Parliament in Ottawa","Quebec's provincial legislature — where Quebec laws are made","A cultural organization","A language school"],1,"L'Assemblée nationale = Quebec's provincial parliament at Quebec City. This is where Loi 101, the education laws, healthcare regulations, and all provincial policies are created. 125 deputies (députés) elected by Quebecers make laws that affect your daily life — healthcare, education, housing, language.",1),
     {type:"match",prompt:"Match the Quebec civic term to its meaning",pairs:[["Loi 101","French Language Charter — French is official"],["l'Assemblée nationale","Quebec's provincial legislature"],["la dualité linguistique","Canada's two official languages (French and English)"],["les peuples autochtones","Indigenous peoples of Quebec"],["la Commission des droits de la personne","Human Rights Commission"]],explain:"These 5 civic terms appear in citizenship tests, CLB reading passages, and real Quebec conversations. Understanding Quebec's political and rights landscape means you can participate meaningfully in democratic discussions and know where to turn if your rights are violated.",diff:2},
     {type:"fill",before:"Au Québec, en vertu de la Loi 101, vous avez le droit d'être servi en",blank:"___",after:"dans tous les commerces et services.",options:["français","anglais","les deux langues","n'importe quelle langue"],correct:0,explain:"En français — Loi 101 guarantees the right to be served in French in all businesses and services in Quebec. If a business refuses to serve you in French, you can report it to the Office québécois de la langue française (OQLF). This is YOUR right as a Quebec resident!",diff:1},
     mcq("Canada's two official languages are recognized under:",["Loi 101","La Loi sur les langues officielles du Canada — federal law guaranteeing both French and English at the federal level","La Constitution du Québec","La Charte des droits et libertés"],1,"La Loi sur les langues officielles (Official Languages Act) guarantees French AND English at the federal level. This is different from Loi 101 (Quebec-only, French-only). The federal government must serve Canadians in both languages. Understanding this distinction clarifies why French is required in Quebec but English rights exist federally.",2),
     {type:"scene",story:"In her citizenship preparation class, Amara reads: 'Le Canada est une fédération composée de dix provinces et trois territoires. Le Québec est la seule province officiellement francophone. Le gouvernement fédéral à Ottawa et le gouvernement provincial à Québec ont des responsabilités distinctes. La santé et l'éducation relèvent des provinces, tandis que la défense nationale et l'immigration relèvent du gouvernement fédéral.'",prompt:"What government structure does this describe?",options:["Federal-provincial division: provinces control health and education; federal controls defence and immigration","A unitary government where Ottawa controls everything","A system where Quebec controls immigration","A system with no provincial governments"],correct:0,explain:"Federal division of powers: les provinces (including Quebec) are responsible for santé (health) and éducation (education). Le gouvernement fédéral (Ottawa) handles défense nationale (national defence) and immigration. This is the essential knowledge for Canadian citizenship — understanding who governs what affects where you go for services!",diff:2},
     {type:"order",prompt:"Assert your right: I have the right to be served in French in this business",words:["J'ai","le","droit","d'être","servi(e)","en","français","dans","ce","commerce"],answer:["J'ai","le","droit","d'être","servi(e)","en","français","dans","ce","commerce"],explain:"J'ai le droit d'être servi(e) en français dans ce commerce — a sentence that invokes Loi 101 clearly and respectfully. Être servi(e) = to be served (passive). Dans ce commerce = in this business. Knowing this sentence means you can exercise your language rights confidently in Quebec.",diff:2},
     wr("Write a short paragraph about one Quebec or Canadian right that is important to you as an immigrant",["j'ai le droit de","en vertu de","la loi garantit","il est important que","la Charte","les droits et libertés","protège"],"Civic knowledge in French transforms you from a resident to a participant in Quebec democracy. Every right you know about is a right you can exercise. Write about rights that matter most in your daily life — this reflection prepares you for both citizenship exams and meaningful community engagement.",2)]),

  mkL("b1-13","B1 Vocabulary — Health, Work & Society",30,"mixed",
    "At B1 level, you need a robust vocabulary across health, employment, and social topics — the three pillars of immigrant life in Quebec. Today you learn 60 key vocabulary words across these domains, with pronunciation guides and contextual usage. This vocabulary directly prepares you for TEF Canada reading passages and workplace communications.",
    ["SANTÉ: le diagnostic = diagnosis","SANTÉ: ordonner = to prescribe","SANTÉ: une réclamation d'assurance = insurance claim","SANTÉ: chronique = chronic","SANTÉ: la prévention = prevention","TRAVAIL: postuler = to apply (for a job)","TRAVAIL: le recrutement = recruitment","TRAVAIL: une mise à pied = layoff","TRAVAIL: la rémunération = compensation/pay","SOCIÉTÉ: l'accueil = welcome/reception of immigrants","SOCIÉTÉ: s'épanouir = to thrive/flourish","SOCIÉTÉ: la cohabitation = cohabitation/living together","SOCIÉTÉ: le bénévolat = volunteering","SOCIÉTÉ: la solidarité = solidarity","SOCIÉTÉ: s'impliquer = to get involved"],
    [mcq("Your doctor says you have une maladie chronique. What does this mean?",["A temporary illness","A chronic/long-term condition","A contagious disease","A very serious disease requiring surgery"],1,"Chronique = chronic (long-term, ongoing). Une maladie chronique = a chronic illness. This word appears in insurance forms, medical records, and RAMQ documents. If you have a chronic condition, knowing this word helps you communicate with Quebec healthcare providers accurately.",1),
     mcq("A job posting says 'Nous sommes en recrutement actif'. What does this mean?",["The position is filled","We are actively recruiting/hiring","Recruitment is closed","You must contact a recruiter first"],1,"En recrutement actif = actively recruiting. This is positive news — they're looking for people now! Postuler = to apply. Je voudrais postuler pour ce poste = I would like to apply for this position. These words appear on job sites like LinkedIn and Jobboom — essential for your Quebec job search.",1),
     {type:"match",prompt:"Match the B1 vocabulary word to its domain and meaning",pairs:[["s'épanouir","society — to thrive/flourish"],["une mise à pied","work — a layoff"],["le bénévolat","society — volunteering"],["la prévention","health — prevention"],["la rémunération","work — compensation/pay"]],explain:"These 5 words span the three domains of B1 vocabulary: health, work, and society. S'épanouir and bénévolat describe successful integration. Mise à pied and rémunération are crucial workplace rights vocabulary. La prévention is key in Quebec public health messaging (vaccination, cancer screening, etc.).",diff:2},
     {type:"fill",before:"Après cinq ans au Québec, Sara commence vraiment à",blank:"___",after:"dans sa nouvelle communauté.",options:["s'épanouir","s'impliquer","s'adapter","s'intégrer"],correct:0,explain:"S'épanouir = to thrive/flourish. À s'épanouir dans sa communauté = to flourish in her community. This is the most beautiful word for successful integration — beyond just surviving, truly thriving. When you s'épanouissez in Quebec, you've made it your home in the deepest sense.",diff:2},
     mcq("Your company announces 'des mises à pied pour raisons économiques'. What should you do?",["Nothing — it's just an announcement","Understand that layoffs are coming and know your rights with the CNESST","Apply for more jobs at your company","Ask for more work"],1,"Mise à pied = layoff. Pour raisons économiques = for economic reasons. If you receive a mise à pied notice, you have rights: préavis (notice period), indemnité de départ (severance pay), assurance-emploi (EI). Immediately contact CNESST or a legal aid service. Knowing this vocabulary protects you financially.",2),
     {type:"scene",story:"Ravi reads this Quebec government integration program description: 'Ce programme vise à favoriser l'accueil et l'intégration des nouveaux arrivants en facilitant leur épanouissement personnel et professionnel. Les participants s'impliquent dans des activités de bénévolat communautaire, renforcent la solidarité et développent des compétences professionnelles adaptées au marché québécois.'",prompt:"What are the program's goals according to this B1-level text?",options:["Welcome/integration of newcomers; personal and professional flourishing; community volunteering; solidarity building; professional skills development","Only French language learning","Only job training","Only cultural activities"],correct:0,explain:"The program covers: accueil (welcome), intégration, épanouissement personnel et professionnel (personal and professional flourishing), bénévolat communautaire (community volunteering), solidarité (solidarity), compétences professionnelles (professional skills). Understanding this description means you can access and benefit from real Quebec integration programs!",diff:2},
     {type:"order",prompt:"Express: I would like to get involved in community volunteering to better integrate",words:["Je","voudrais","m'impliquer","dans","le","bénévolat","communautaire","pour","mieux","m'intégrer"],answer:["Je","voudrais","m'impliquer","dans","le","bénévolat","communautaire","pour","mieux","m'intégrer"],explain:"Je voudrais m'impliquer dans le bénévolat communautaire pour mieux m'intégrer — using 3 B1 vocabulary words naturally: m'impliquer (to get involved), bénévolat (volunteering), m'intégrer (to integrate). This sentence, said to a Quebec community centre, immediately opens doors. Volunteering is one of the most effective integration paths in Quebec!",diff:2},
     wr("Write 3 sentences using B1 vocabulary from health, work, and society domains",["s'épanouir","postuler","la prévention","le bénévolat","la rémunération","s'impliquer","la solidarité","le recrutement"],"Covering all three domains (santé, travail, société) in your writing shows B1 vocabulary range — a specific TEF Canada evaluation criterion. This vocabulary practice doubles as preparation for reading comprehension: when these words appear in TEF passages, you recognize them instantly.",3)]),

  mkL("b1-14","CLB 5 Reading — Strategies & Practice",30,"reading",
    "CLB 5 reading means understanding main ideas, specific details, implied meanings, and vocabulary in context from news articles, formal letters, workplace documents, and online texts. The TEF Canada compréhension écrite section is 60 minutes with multiple texts and question types. Today you learn the strategies that distinguish 60% readers from 85% readers.",
    ["Stratégie 1: lire les questions avant le texte","Stratégie 2: identifier le type de texte (article, lettre, annonce...)","Stratégie 3: chercher l'idée principale du premier paragraphe","Stratégie 4: ne pas bloquer sur les mots inconnus — utiliser le contexte","Stratégie 5: les réponses sont souvent paraphrasées (synonymes!)","Stratégie 6: méfier-vous des 'distracteurs' (réponses presque vraies)","Stratégie 7: vérifier les réponses contre le texte, pas votre mémoire","Question type: idée principale (what is the text about?)","Question type: détail spécifique (find the specific number/name/fact)","Question type: vocabulaire en contexte (what does this word mean HERE?)"],
    [mcq("The most important TEF reading strategy is:",["Read the whole text carefully before looking at questions","Read questions FIRST, then read the text to find specific answers","Only read the first and last paragraphs","Guess answers you don't know"],1,"Read questions first! This transforms passive reading into active hunting. You know exactly what information to find before you read. In TEF Canada reading, time is limited — question-first reading is 30% more efficient than text-first reading. Practice this until it's automatic.",2),
     mcq("You encounter an unknown word in a TEF reading text. You should:",["Skip the question","Stop and try to translate it using grammar rules","Use context (surrounding sentences, text type, logical meaning) to infer meaning","Mark it wrong automatically"],2,"Contexte = your most powerful reading tool! French vocabulary in context is often inferrable from: root words you know (pre-, post-, re-), surrounding sentences, logical meaning in the text type. Ne bloquez jamais sur un mot inconnu — keep reading and infer from context.",1),
     {type:"match",prompt:"Match the reading question type to its strategy",pairs:[["Idée principale (main idea)","read title + first paragraph + last paragraph"],["Détail spécifique","scan for keywords from the question"],["Vocabulaire en contexte","ignore definition you know; find meaning from surrounding text"],["Inférence (implied meaning)","read between the lines + author's purpose"],["Distracteurs (wrong answers)","verify against text — partially true ≠ correct"]],explain:"Different question types require different reading modes: skimming (main idea), scanning (specific details), deep reading (vocabulary, inference). Professional readers switch between these modes automatically. TEF Canada tests all of them — practice each mode separately!",diff:2},
     {type:"fill",before:"Dans le TEF Canada, la section de compréhension écrite dure",blank:"___",after:"et comprend plusieurs textes de types variés.",options:["60 minutes","30 minutes","2 heures","15 minutes"],correct:0,explain:"60 minutes for TEF compréhension écrite. Multiple texts: news articles, formal letters, advertisements, government announcements, workplace communications. Each text has 3-6 questions. Time management: approximately 12 minutes per text (5 texts). Practice timing yourself with real texts!",diff:1},
     mcq("A TEF reading answer option is 'partially true' — it mentions something in the text but not exactly what's asked. You should:",["Choose it because it's partially correct","Reject it — distracteurs are designed to seem right but miss the specific question asked","Choose it if no other answer mentions the text","Skip the question"],1,"Distracteurs! Wrong answers in TEF reading are often partially true — they mention real information from the text but don't answer the specific question. Always return to the text and verify: does this answer EXACTLY answer THIS question? Partial truth ≠ correct answer.",2),
     {type:"scene",story:"TEF Reading Text (excerpt): 'La ville de Montréal accueille chaque année plus de 40 000 nouveaux immigrants. Selon le Bureau d'intégration des nouveaux arrivants (BINAM), 75% d'entre eux s'établissent dans la région métropolitaine. Les services offerts incluent des cours de français gratuits, une aide à la recherche d'emploi et un accompagnement dans les démarches administratives.' Question: 'Quel pourcentage d'immigrants reste dans la région métropolitaine?'",prompt:"What is the correct answer and how do you find it efficiently?",options:["75% — found by scanning for the percentage symbol/number in the text after reading this specific question first","40,000 — that's the total number of immigrants","100% — all immigrants mentioned","The text doesn't give this information"],correct:0,explain:"Strategy in action: question asks for a percentage (%) → scan for numbers/% in text → find 75% → confirm context (s'établissent dans la région métropolitaine = stay in the metropolitan region). Scanning takes 15 seconds. Reading the whole text first would take 3 minutes. Scanning = TEF efficiency!",diff:2},
     {type:"order",prompt:"List the 3-step TEF reading process in order",words:["1.","Lire","les","questions","→","2.","Scanner","le","texte","→","3.","Vérifier","les","réponses"],answer:["1.","Lire","les","questions","→","2.","Scanner","le","texte","→","3.","Vérifier","les","réponses"],explain:"1. Lire les questions → 2. Scanner le texte → 3. Vérifier les réponses. This 3-step process is the TEF reading framework. Step 3 is crucial: verify answers in the text, not from memory. Verification prevents distracteur errors that cost points at the finish line. Build this habit now!",diff:1},
     wr("Describe in French the 3 biggest challenges you face when reading French texts and your strategies to overcome them",["j'ai du mal à","le vocabulaire inconnu","la vitesse","les questions de compréhension","pour surmonter","ma stratégie est","le contexte","scanner"],"Self-diagnosing your reading weaknesses in French is metacognitive skill — a B1+ ability. Write honestly: what specific types of texts challenge you most (news? legal? scientific?), what word types block you (technical? abstract?), what question types are hardest (inference? vocabulary?). Then write your strategy. This analysis accelerates improvement.",3)]),

  mkL("b1-15","Nuance & Hedging — Saying Maybe in French",20,"speaking",
    "Professional French is often about what you DON'T say directly. Hedging, qualifying, expressing uncertainty, and nuancing your statements are marks of sophistication. 'It seems to me that...', 'One could argue that...', 'To a certain extent...' — these structures show critical thinking and protect you from overstatement. Today you master professional uncertainty.",
    ["Il me semble que = It seems to me that (uncertainty)","On pourrait dire que = One could say that","Dans une certaine mesure = To a certain extent","Il est possible que + subjonctif = It is possible that","Apparemment = Apparently","D'après ce que je comprends = From what I understand","Sous réserve de = Subject to / Pending","Cela dépend de = It depends on","Nuancer = to nuance/qualify a statement","Remettre en question = to question/challenge"],
    [mcq("Which phrase expresses appropriate uncertainty about a professional opinion?",["C'est absolument vrai","Il me semble que cette approche pourrait être améliorée","Je sais que j'ai raison","C'est complètement faux"],1,"Il me semble que = it seems to me that — expresses an opinion with appropriate professional uncertainty. Il me semble que cette approche pourrait être améliorée = It seems to me that this approach could be improved. Much more professional than 'cette approche est mauvaise'!",1),
     mcq("'On pourrait dire que l'immigration enrichit la culture québécoise.' What effect does this phrasing have?",["It makes the statement weaker and less convincing","It presents the idea as a general/arguable observation rather than absolute fact — intellectually sophisticated","It shows you don't have an opinion","It is grammatically incorrect"],1,"On pourrait dire que = one could say that. This presents the idea as a reasonable observation — not personal opinion, not absolute fact. It invites agreement rather than demanding it. Very effective in professional discussions and TEF Canada speaking!",1),
     {type:"match",prompt:"Match the hedging phrase to its level of certainty",pairs:[["Il est certain que","high certainty (followed by indicatif)"],["Il me semble que","moderate uncertainty"],["Il est possible que + subjonctif","genuine uncertainty"],["Dans une certaine mesure","partial agreement"],["Apparemment","based on what others say"]],explain:"Professional French uses certainty levels strategically. Too much certainty sounds arrogant. Too much uncertainty sounds unconfident. The sweet spot: strong position + appropriate qualifier. Il me semble que = I have an informed opinion. Dans une certaine mesure = I agree partially. Master these levels!",diff:2},
     {type:"fill",before:"",blank:"___",after:"ce que je comprends, votre demande sera traitée dans 30 jours.",options:["D'après","Selon","D'après ce que","Selon ce"],correct:2,explain:"D'après ce que je comprends = from what I understand. This hedge is perfect when relaying information you're not 100% certain about — from a government letter, a colleague's explanation, or a news article. It protects you from being wrong while still being helpful.",diff:2},
     mcq("Your colleague asks for a definitive timeline. You're not certain. Best response:",["The project will finish March 15th","I have no idea","Dans une certaine mesure, le projet devrait se terminer vers mi-mars, sous réserve de confirmation","The project is done"],2,"Dans une certaine mesure = to a certain extent. Devrait = should (conditionnel — uncertainty). Vers mi-mars = around mid-March (approximate). Sous réserve de confirmation = subject to confirmation. This response gives useful information while honestly flagging uncertainty. Professional and trustworthy!",2),
     {type:"scene",story:"In a meeting, Ravi is asked about market projections he's not fully confident in. He responds: 'D'après ce que je comprends des données actuelles, il me semble que la croissance sera positive. On pourrait dire que nous sommes sur la bonne voie. Cependant, dans une certaine mesure, cela dépend des conditions économiques. Il est possible que nous devions revoir ces projections en juin.'",prompt:"How does Ravi use hedging to remain professional despite uncertainty?",options:["4 hedging techniques: d'après ce que je comprends, il me semble que, on pourrait dire que, dans une certaine mesure, il est possible que — appropriately uncertain throughout","He just admits he doesn't know","He gives false certainty","He refuses to answer"],correct:0,explain:"Ravi uses 5 hedging techniques across 4 sentences! D'après ce que je comprends (attribution), il me semble que (personal uncertainty), on pourrait dire (general observation), dans une certaine mesure (partial statement), il est possible que + subjonctif (genuine uncertainty). This is exactly how senior professionals communicate when data is incomplete — honest, helpful, and sophisticated.",diff:3},
     {type:"order",prompt:"Build: To a certain extent it seems to me this approach could work",words:["Dans","une","certaine","mesure,","il","me","semble","que","cette","approche","pourrait","fonctionner"],answer:["Dans","une","certaine","mesure,","il","me","semble","que","cette","approche","pourrait","fonctionner"],explain:"Dans une certaine mesure, il me semble que cette approche pourrait fonctionner — three layers of qualification: partial agreement (dans une certaine mesure), personal uncertainty (il me semble), conditionnel possibility (pourrait). This level of nuance marks a sophisticated B1-B2 speaker. Use it when you believe something but aren't 100% certain.",diff:3},
     wr("Write 3 sentences about Quebec's immigration policy using hedging language",["il me semble que","on pourrait dire que","dans une certaine mesure","il est possible que","d'après ce que je comprends","apparemment","sous réserve de"],"Hedging is the vocabulary of intellectual honesty — saying what you believe while acknowledging you might be wrong. In TEF Canada speaking, appropriate hedging shows sophistication. In the Quebec workplace, it shows professional maturity. Practice hedging your real opinions: it's harder than it sounds!",3)]),

  mkL("b1-16","B1 Review — TEF Canada Final Preparation",30,"mixed",
    "Félicitations! You've completed the B1 level — CLB 5 equivalent. This final lesson integrates all B1 skills: opinion expression, conditional structures, relative clauses, nuance, TEF strategies, and Quebec civic knowledge. Today you complete a full TEF Canada practice simulation across all 4 skills. You are ready for your exam!",
    ["B1/CLB 5 = can communicate in most everyday and workplace situations","TEF Canada: 4 sections totalling approximately 3 hours","Compréhension de l'écoute: 40 minutes","Compréhension écrite: 60 minutes","Expression écrite: 60 minutes","Expression orale: 35 minutes","Scores: CLB 4 = basic pass; CLB 5 = strong pass; CLB 6 = excellent","Registration: tefcanada.ca or at an authorized centre","Preparation timeline: 3-6 months of structured study","Your Franco journey: Foundation → A1 → A2 → B1 ✓"],
    [mcq("You are ready for TEF Canada CLB 5 when you can:",["Only introduce yourself","Handle most everyday situations, express opinions, write structured texts, and understand extended conversations","Reach native-level fluency in all situations","Only read simple texts"],1,"CLB 5 = handle most everyday + professional situations, express and justify opinions, write 200-word structured arguments, understand main ideas and details in extended listening. If you've completed Franco Foundation through B1, you have the skills. Practice is what converts knowledge to confident performance!",1),
     {type:"match",prompt:"Match the TEF section to its key strategy",pairs:[["Compréhension de l'écoute","read questions first, note numbers immediately"],["Compréhension écrite","scan for keywords, watch for distracteurs"],["Expression écrite","plan (5-7min), structure (4 paragraphs), revise (10min)"],["Expression orale","structure mentally (don't memorize), use time-buying phrases"],["Overall TEF strategy","practice under timed conditions before exam day"]],explain:"Four skills — four strategies. Mastering each strategy separately then combining them is how TEF candidates go from CLB 4 to CLB 6. You've now studied all four. The final step: timed practice under exam conditions. Simulate the test before you take the test!",diff:2},
     {type:"fill",before:"Pour obtenir la résidence permanente via Entrée express, j'ai besoin d'un minimum de",blank:"___",after:"en expression orale et en compréhension de l'écoute.",options:["CLB 7","CLB 4","CLB 10","CLB 5"],correct:0,explain:"Express Entry requires CLB 7 in speaking and listening for the Federal Skilled Worker program. CLB 5 is required for citizenship, CLB 7+ for most Express Entry programs. Knowing your specific immigration pathway requirement is crucial — don't study for CLB 5 if your pathway needs CLB 7!",2),
     mcq("The BEST preparation for TEF Canada oral is:",["Memorizing scripted answers to 100 potential questions","Taking Franco's B1 lessons + practicing 15-minute timed responses daily + recording yourself + analyzing for improvement","Translating English answers to French","Only studying grammar rules"],1,"Structured practice with self-analysis is the most effective preparation: B1 knowledge (structures, vocabulary, strategies) + timed practice + self-recording + analysis of specific weaknesses. Recording yourself is uncomfortable but irreplaceable — you hear things you never notice while speaking.",2),
     {type:"scene",story:"Complete B1 integration: Ravi writes to Immigration Canada after failing one TEF section: 'Je vous écris suite à mes résultats du TEF Canada du 15 avril. Bien que j'aie obtenu CLB 6 en expression orale et en compréhension écrite, il me semble que mon résultat en expression écrite, soit CLB 4, ne correspond pas à mon niveau réel. Je voudrais savoir s'il est possible de demander une révision, à condition que des preuves supplémentaires puissent être soumises.'",prompt:"Which B1 structures appear in this formal letter?",options:["Suite à (formal opening), bien que + subjonctif, il me semble que (hedging), soit (= namely), à condition que + subjonctif — 5 B1 structures!","Only basic structures","No B1 structures","Only formal vocabulary, no grammar structures"],correct:0,explain:"Ravi's letter uses 5 B1 structures: suite à (formal follow-up opener), bien que + subjonctif (bien que j'aie obtenu — concession), il me semble que (professional hedging), soit (= namely/that is), à condition que + subjonctif (conditional). This formal appeal letter demonstrates complete B1 mastery in an authentic, high-stakes situation.",diff:3},
     {type:"order",prompt:"State your achievement: I have completed B1 and I am ready to take the TEF Canada",words:["J'ai","complété","le","niveau","B1","et","je","suis","prêt(e)","à","passer","le","TEF","Canada"],answer:["J'ai","complété","le","niveau","B1","et","je","suis","prêt(e)","à","passer","le","TEF","Canada"],explain:"J'ai complété le niveau B1 et je suis prêt(e) à passer le TEF Canada — say this with confidence, because it's TRUE! Prêt(e) = ready (masculine/feminine). You have completed Franco's complete Foundation through B1 curriculum. The knowledge is there. The structures are there. Trust your preparation. Bonne chance! 🍁",diff:1},
     wr("Write your commitment statement for your French learning journey: where you started, what you achieved, and where you are going",["j'ai commencé","grâce à","j'ai appris","bien que","je suis maintenant","je me prépare à","mon objectif est","dans les prochains mois","je continuerai"],"Your B1 completion is a genuine achievement. This commitment statement, written in B1 French, is proof of your progress. Save it. Read it when you pass the TEF Canada. Read it when you get your permanent residency. Read it when you become a Canadian citizen. Votre parcours est remarquable. 🍁🇨🇦",3)]),

  mkL("b1-17","Advanced Listening — Accents & Speeds",30,"listening",
    "CLB 5-6 listening requires understanding fast, accented, and colloquial speech — not just slow, clear classroom French. Key challenges: liaison (les amis → lezami), elision (je ne sais pas → ch'pas), Quebec accent features (moé/toé/ousque/faque), contractions (tu as → t'as, il y a → y'a), and reduced syllables (maintenant → main'nant, peut-être → p'têt). Strategy: listen for content words (nouns, verbs, key adjectives); let function words blur. Practice: movies, radio, podcasts, conversations.",
    ["liaison: les enfants → lezenfants","elision: je ne sais pas → ch'pas","contractions: tu as → t'as","y'a = il y a (very common)","faque = fait que (Quebec: so, therefore)","tsé = tu sais (Quebec discourse marker)","là = multi-purpose: now / you see / emphasis","main'nant = maintenant (reduced)","CLB 5 listening: main ideas + key details","CLB 6 listening: details, attitude, implied meaning"],
    [mcq("In fast Quebec French, 'ch\\'pas' most likely means:",["je ne suis pas","je ne sais pas","c\\'est pas","que c\\'est pas"],1,"Ch'pas = je ne sais pas (I don't know) — with je ne → jne → chne → ch', ne dropped entirely. Very common in spoken Quebec French. Don't be alarmed by this contraction in listening tests or real conversations!",2),
     mcq("You hear: 'Faque là, t\\'as juste à appeler, tsé.' The closest translation is:",["So now, you just have to call, you know","Let's go, you called, OK","Then you called, right","Call quickly now"],0,"Faque là (so now/OK so), t'as juste à (you just have to), tsé (you know/right). Classic Quebec spoken French. Each element is a contracted/reduced form. Understanding these markers is key for CLB 6 listening!",3),
     {type:"scene",story:"You're listening to a Quebec radio news bulletin. The speaker says: 'L\\'gouvernement provincial a annoncé c\\'matin des nouvelles mesures pour aider les immigrants à s\\'intégrer. Selon l\\'ministre, y\\'a plusieurs milliers d\\'personnes qui attendent leur résidence permanente depuis plus d\\'deux ans.'",prompt:"What is the main news reported?",options:["The government will help immigrants integrate — new measures announced","Immigrants are being expelled","A new immigration law passed","Ministers are waiting for residency"],correct:0,explain:"L'gouvernement → le gouvernement, c'matin → ce matin, l'ministre → le ministre, y'a → il y a, d'personnes → de personnes. Even with heavy liaisons and elisions, content words are clear: gouvernement, annoncé, mesures, immigrants, s'intégrer. Focus on content words — the grammar around them blurs in natural speech!",diff:3}]),

  mkL("b1-18","TEF Canada Reading Strategies — Advanced",35,"reading",
    "CLB 5-6 reading involves longer texts, implicit meaning, and nuanced vocabulary. Strategy REAP: Read the questions FIRST (know what to look for), Extract key words from questions, Actively skim for those words, Pinpoint and verify. Common question types: main idea (titre, thème principal), specific detail (qui, quand, combien), inference (what does the author imply), vocabulary in context (le mot X dans ce texte signifie), and purpose (pourquoi l\\'auteur cite-t-il...?). Traps: distracteurs that use words from the text but twist the meaning.",
    ["Read questions FIRST before the text","Underline question keywords","Skim for headings, first sentences of paragraphs","Inference ≠ stated fact — look for implied meaning","Distracteurs use text words but change meaning","Vocabulary in context: re-read the full sentence","Negative questions: 'Lequel N\\'est PAS mentionné?'","Time management: 60 min for 50 questions = 70 sec each","CLB 5: main ideas + key details","CLB 6: details, inferences, implicit meaning"],
    [mcq("You see the TEF question: 'Que sous-entend l\\'auteur dans le deuxième paragraphe?' This asks for:",["a direct quote from paragraph 2","the main idea of the whole text","what the author implies (not states directly)","a vocabulary definition"],2,"Sous-entend = implies/suggests. This is an inference question — you need to read BETWEEN the lines. The answer won't be directly stated. Look for the author's tone, word choice, and what logically follows from what they say. Inference questions are the hardest TEF question type!",2),
     {type:"scene",story:"TEF Reading text: 'Malgré une politique d\\'intégration volontariste, le taux d\\'emploi chez les immigrants qualifiés reste inférieur de 12 points à celui des natifs.' Question: L\\'auteur suggère-t-il que la politique est un succès?",prompt:"Based on the text, the author:",options:["Implies the policy has not fully achieved its goals (gap between intent and outcomes)","States the policy is a complete failure","Confirms the policy is a success","Provides no opinion on the policy"],correct:0,explain:"'Malgré' (despite) + 'volontariste' (ambitious) creates contrast with the 12-point employment gap result. The structure implies: ambitious policy → disappointing outcome. This is INFERENCE — the author doesn't say 'the policy failed', but the contrast between 'volontariste' and the gap implies it.",diff:3},
     mcq("Best strategy when you see an unknown word in a TEF text:",["immediately skip the question","look it up in a dictionary","re-read the full sentence and surrounding sentences to infer meaning from context","guess randomly"],2,"Context inference! Read the whole sentence, check for cognates (French-English similarities), use prefixes/suffixes (im- = not, -tion = noun), and check what grammatically makes sense. TEF doesn't test obscure vocabulary — most unknown words can be guessed from context at B1-B2 level.",1)]),

  mkL("b1-19","Expressing Doubt & Certainty",20,"speaking",
    "Expressing degrees of certainty is key for B1 fluency! CERTAINTY: j\\'en suis certain(e), sans aucun doute, il est évident que, je suis convaincu(e) que. PROBABILITY: il est probable que + indicatif, sans doute (= probably, not 'without doubt'!), il me semble que. POSSIBILITY: il est possible que + subjonctif, il se peut que + subjonctif. DOUBT: je doute que + subjonctif, j\\'ai des réserves quant à.",
    ["CERTAIN: je suis certain(e) que + indicatif","PROBABLE: il est probable que + indicatif","POSSIBLE: il est possible que + subjonctif","DOUBT: je doute que + subjonctif","sans doute ≠ without doubt (= probably!)","peut-être que + indicatif OR peut-être + inversion","il me semble que (it seems to me that)","il se peut que + subjonctif (it may be that)","j\\'ai des réserves quant à (formal doubt)"],
    [mcq("'Sans doute il viendra.' This means:",["Without any doubt, he will come","He will probably come","He will not come","He certainly won\\'t come"],1,"TRAP! 'Sans doute' in modern French = probably (not 'without doubt'!). If you want to say 'without any doubt', use 'sans aucun doute'. 'Il viendra sans doute' = He will probably come. A classic false friend within French itself!",2),
     mcq("'Je doute qu\\'il vienne à temps.' Why is 'vienne' in the subjunctive?",["douter que triggers subjunctive","it\\'s in the future","the sentence is negative","it\\'s a question"],0,"Douter que + subjonctif. Verbs of doubt (douter que, ne pas croire que, ne pas être sûr que) trigger subjunctive. Compare: 'Je crois qu\\'il VIENT' (indicatif — belief) vs 'Je doute qu\\'il VIENNE' (subjonctif — doubt).",2),
     wr("Express doubt about a situation at work or in school",["je doute que","il se peut que","j\\'ai des réserves quant à","il est possible que"],"Je doute que cette décision soit dans l\\'intérêt de tous les employés. J\\'ai des réserves quant à l\\'efficacité de la nouvelle politique. — Doubt + subjonctif. Perfect for professional French where you need to disagree diplomatically!",2)]),

  mkL("b1-20","Professional Emails & Correspondence",35,"writing",
    "Master the full professional French email: OPENING: Madame, Monsieur (never 'Chère Madame' in formal). SUBJECT: clear and specific: 'Objet: Demande de congé — 15 au 22 juin 2025'. CLOSING: 'Dans l\\'attente de votre réponse, je vous prie d\\'agréer, Madame/Monsieur, l\\'expression de mes salutations distinguées.' (very formal) OR 'Cordialement' (standard). AVOID: 'Cher/Chère', exclamation marks, emoji.",
    ["Objet: specific and concise","Madame, Monsieur (pas Cher/Chère)","Je me permets de vous contacter au sujet de...","Suite à notre conversation du [date]...","Je vous serais reconnaissant(e) de bien vouloir...","Dans l\\'attente de votre réponse...","Cordialement (standard) vs Salutations distinguées (formal)","Bien à vous (semi-formal, known contact)","Veuillez trouver ci-joint... (please find attached)","PJ: pièce jointe (attachment)"],
    [mcq("Which closing is MOST appropriate for a government ministry?",["Gros bisous!","Bien à toi","Je vous prie d\\'agréer, Monsieur, l\\'expression de mes salutations distinguées.","Ciao!"],2,"The full formal closing! 'Je vous prie d\\'agréer [TITRE], l\\'expression de mes salutations distinguées' is the gold standard for formal institutional correspondence. 'Bien à toi' is informal (tu), 'gros bisous' is for close friends.",1),
     {type:"match",prompt:"Match each email opening to the correct context",pairs:[["Madame la Directrice","Writing to a female director formally"],["Monsieur","Unknown male recipient, formal"],["Madame, Monsieur","Unknown recipient, gender unknown"],["Chère collègue","A colleague you know well"],["À qui de droit","Unknown department contact (catch-all)"]],explain:"Salutation choice signals French professional culture mastery. Using 'Madame, Monsieur' for unknown recipient is safest. Government and formal institutions: include full title (Madame la Sous-Ministre). This matters for CLB 6 writing tasks!",diff:2},
     wr("Write a professional email requesting a document from a government office",["je me permets de vous contacter","je vous serais reconnaissant(e)","dans l\\'attente de votre réponse","veuillez trouver ci-joint","objet:","cordialement"],"Objet: Demande de document — Dossier d\\'immigration\\n\\nMadame, Monsieur,\\n\\nJe me permets de vous contacter au sujet de mon dossier. Je vous serais reconnaissant de bien vouloir m\\'envoyer une copie de l\\'attestation de dépôt.\\n\\nDans l\\'attente de votre réponse, je vous prie d\\'agréer, Madame, Monsieur, l\\'expression de mes salutations distinguées.",3)]),

  mkL("b1-21","Numbers in Context — Statistics & Data",25,"reading",
    "B1 French requires handling numbers in authentic texts. French rules: virgule (comma) for decimals (3,5 = 3.5), espace for thousands (1 000 000). Fractions: un demi, un tiers, un quart, trois quarts. Key phrases: le taux de, en hausse de, en baisse de, environ, approximativement. TEF reading often includes tables, charts, and statistics.",
    ["décimales: virgule (3,5 pas 3.5)","milliers: espace (1 000 pas 1,000)","un demi, un tiers, un quart, trois quarts","le taux de chômage = the unemployment rate","environ / approximativement = approximately","la moitié = half","en hausse de 5% = up by 5%","en baisse de / une réduction de","par rapport à = compared to","soit = namely/that is"],
    [mcq("In a French document, '78,5%' means:",["785%","7.85%","78.5%","0.785%"],2,"In French, the comma (virgule) is the decimal separator — so 78,5 = 78.5 in English notation. Critical for reading statistics and financial documents accurately!",1),
     mcq("'Environ les deux tiers des candidats ont réussi.' means:",["2/3 of candidates passed","2 thirds were tested","3/2 candidates passed","2 candidates out of 3 failed"],0,"Deux tiers = two thirds. 'Environ' = approximately. Fractions: un tiers (1/3), deux tiers (2/3), un quart (1/4), trois quarts (3/4). Common in TEF reading statistics sections!",1),
     {type:"scene",story:"You read: 'En 2024, quelque 550 000 nouveaux résidents permanents ont été accueillis au Canada, en hausse de 12% par rapport à l\\'année précédente. Parmi eux, environ 45% provenaient d\\'Asie du Sud, soit une augmentation par rapport aux 38% enregistrés en 2022.'",prompt:"What changed from 2022 to 2024 for South Asian immigrants?",options:["Their proportion increased from 38% to 45%","Their proportion decreased","The total number was 38,000","No change is mentioned"],correct:0,explain:"'En hausse de' = up by, 'par rapport à' = compared to, 'soit' = namely. South Asian proportion: 38% (2022) → 45% (2024) = increase of 7 percentage points. CLB 6 reading requires tracking multiple statistics!",diff:2}]),

  mkL("b1-22","The Imperative — Commands & Instructions",20,"speaking",
    "The imperative gives instructions, commands, and directions! Formation: drop subject from présent indicatif → drop -s from -er tu form. Irregular: être (sois/soyons/soyez), avoir (aie/ayons/ayez). PRONOUNS: positive: Donne-le-moi! Negative: Ne me le donne pas! POLITE alternative: conditionnel (Pourriez-vous fermer la porte?).",
    ["tu form -er: enlève le -s (mange, pas manges)","nous form = let\\'s: allons-y!","être: sois, soyons, soyez","avoir: aie, ayons, ayez","positif: Donne-le-moi (pronoun after, moi not me)","négatif: Ne me le donne pas (pronoun before)","vas-y (liaison adds -s)","conditionnel = softer/polite alternative","savoir: sache, sachons, sachez"],
    [mcq("'___ (écouter, tu) bien avant de répondre!' Correct imperative:",["Écoutes","Écoutons","Écoute","Écouter"],2,"Écoute! — tu imperative of -er verb: drop the -tu, drop the final -s. Exception when followed by -y or -en: 'Vas-y!' — the -s is added for euphony.",1),
     mcq("Positive imperative: 'Give it to me!' (le → me)",["Me le donne!","Donne-le-moi!","Donne-me-le!","Le donne-moi!"],1,"Donne-le-moi! — Positive imperative: verb first, then pronouns with hyphens. Note: me → moi after positive imperative! Negative: 'Ne me le donne pas!' — pronouns flip back before the verb.",2),
     wr("Write 3 imperative instructions for a new employee on their first day",["sois ponctuel","n\\'oublie pas de","assure-toi de","n\\'hésite pas à"],"1. Sois ponctuel(le) et n\\'oublie pas de pointer à ton arrivée. 2. N\\'hésite pas à poser des questions si tu ne comprends pas. 3. Assure-toi de lire le manuel de l\\'employé avant vendredi.",2)]),

  mkL("b1-23","Describing Trends & Changes",25,"speaking",
    "B1 speaking requires talking about changes over time — crucial for TEF oral tasks. INCREASE: augmenter, croître, monter en flèche (soar). DECREASE: diminuer, baisser, chuter. STABLE: rester stable, stagner. CHANGE: évoluer, se transformer. KEY EXPRESSIONS: en hausse, en baisse, au fil des ans, de plus en plus, de moins en moins.",
    ["augmenter / être en hausse (increase)","diminuer / baisser / être en baisse (decrease)","monter en flèche (soar/skyrocket)","chuter (drop sharply)","rester stable / stagner","évoluer / se transformer","depuis lors (since then)","au fil des ans (over the years)","de plus en plus / de moins en moins","une amélioration notable / une chute importante"],
    [mcq("'Les loyers ont monté en flèche depuis 2020.' This means:",["Rents have slightly increased","Rents have skyrocketed since 2020","Rents have decreased","Rents have been stable"],1,"Monter en flèche = to skyrocket (literally: to rise like an arrow). A vivid expression for sharp increases. Very useful for describing the Quebec housing crisis!",1),
     {type:"scene",story:"TEF Oral: 'Décrivez les changements dans le marché du travail au Canada au cours des dernières années.'",prompt:"Which response best demonstrates B1 trend vocabulary?",options:["The job market changed. More jobs.","Le marché du travail a connu des transformations importantes au fil des ans. Le taux de chômage a progressivement diminué. Cependant, certains secteurs ont vu leurs effectifs chuter, notamment dans l\\'industrie manufacturière.","Jobs went up and down.","Canada has many jobs."],correct:1,explain:"Response B uses: 'a connu des transformations' + 'au fil des ans' + 'progressivement diminué' + 'certains secteurs ont vu chuter'. Four trend structures in two sentences — B1 oral quality!",diff:2},
     wr("Describe how your French has changed since you started learning",["au début","au fil des mois","progressivement","j\\'ai constaté que","je me suis amélioré(e)","depuis lors"],"Au début, je ne comprenais presque rien. Au fil des mois, ma compréhension s\\'est progressivement améliorée. Depuis lors, j\\'ai constaté que ma confiance à l\\'oral a considérablement augmenté.",2)]),

  mkL("b1-24","Reported Speech — Tense Changes",30,"reading",
    "Reported speech (discours indirect) transforms direct quotes. KEY TENSE SHIFTS (when main verb is past): présent → imparfait, passé composé → plus-que-parfait, futur → conditionnel. EXPRESSIONS: hier → la veille, demain → le lendemain, ici → là, maintenant → alors. QUESTIONS: 'Est-ce que tu viens?' → Il a demandé si je venais. Commands: 'Venez!' → Il m\\'a dit de venir.",
    ["présent → imparfait en discours indirect","PC → plus-que-parfait","futur → conditionnel","hier → la veille, demain → le lendemain","est-ce que → si (reported yes/no questions)","question words kept: où, quand, comment, pourquoi","impératif → dire de + infinitif","que vs si: statements use que, questions use si"],
    [mcq("'Je viendrai demain.' Reported: Elle a dit qu\\'elle...",["vient demain","viendra demain","viendrait le lendemain","venait le lendemain"],2,"Viendrait le lendemain — futur (viendrai) → conditionnel (viendrait) + demain → le lendemain. Two changes: tense AND time expression.",2),
     mcq("'Où habitez-vous?' Il a demandé...",["si j\\'habitais","où ils habitaient","où j\\'habitais","s\\'ils habitaient"],2,"Où j\\'habitais — 'où' is kept, 'habitez-vous' → 'j\\'habitais' (présent → imparfait, vous → je for reporter perspective). Statement word order after 'où'.",2),
     wr("Report what your French teacher told the class yesterday",["il/elle nous a dit que","il/elle a expliqué que","il/elle nous a conseillé de"],"La professeure nous a dit que nous devions pratiquer le français tous les jours. Elle a expliqué que la répétition était la clé du progrès. Elle nous a conseillé d\\'écouter la radio française le matin.",2)]),

  mkL("b1-25","Linking Arguments — Advanced Connectors",30,"writing",
    "Move beyond 'et, mais, parce que'! ADDITION: de plus, en outre, par ailleurs. OPPOSITION: cependant, néanmoins, en revanche, toutefois. CAUSE: étant donné que, vu que, puisque, compte tenu de. CONSEQUENCE: c\\'est pourquoi, par conséquent. CONCESSION: certes... cependant, bien que + subj. ILLUSTRATION: notamment, à titre d\\'exemple.",
    ["de plus / en outre / par ailleurs (addition)","cependant / néanmoins / toutefois (contrast)","puisque / étant donné que / vu que (cause)","par conséquent / c\\'est pourquoi (consequence)","certes... cependant (admittedly... however)","notamment / en particulier (notably)","à titre d\\'exemple (as an example)","compte tenu de (given/in light of)","il en résulte que (it follows that)"],
    [mcq("'___ les difficultés actuelles, le programme a été maintenu.' Best connector:",["Parce que","Compte tenu de","Cependant","Notamment"],1,"Compte tenu de = given/in light of. More sophisticated than 'malgré' for formal writing!",2),
     mcq("'Il est bilingue; ___, il a été embauché immédiatement.' Best connector:",["cependant","néanmoins","c\\'est pourquoi","bien que"],2,"C\\'est pourquoi = that\\'s why. Bilingual → hired immediately = logical consequence. Strongest consequence connector!",1),
     wr("Write 4 sentences about a challenge in Canada using 4 different connectors",["certes","cependant","c\\'est pourquoi","en outre","compte tenu de","néanmoins"],"Certes, s\\'adapter à un nouveau pays est difficile. Cependant, j\\'ai progressivement surmonté les obstacles linguistiques. En outre, j\\'ai dû apprendre les codes culturels québécois. C\\'est pourquoi je consacre chaque jour du temps à améliorer mon français.",3)]),

  mkL("b1-26","Health & Social Services in French",30,"vocabulary",
    "Navigate Quebec\\'s health system in French! CLSC = first point of contact for non-emergency health. RAMQ = Régie de l\\'assurance maladie du Québec. Key phrases: prendre rendez-vous, salle d\\'attente, médecin de famille, sans rendez-vous (walk-in), ordonnance, renouveler. Call 811 for Info-Santé nurse advice.",
    ["CLSC = local health services (first contact)","RAMQ = Quebec health insurance card","médecin de famille = family doctor","sans rendez-vous = walk-in clinic","ordonnance = prescription","renouveler une ordonnance = renew a prescription","pharmacien / pharmacienne","811 = Info-Santé nurse line","en cas d\\'urgence = in case of emergency","assurance collective = group benefits"],
    [mcq("You need routine care and have no family doctor. You should go to:",["Emergency at the hospital","A CLSC or clinique sans rendez-vous","Call 911","Do nothing"],1,"CLSC or walk-in clinic. The ER is for emergencies only. 811 is for phone health advice. CLSCs bridge the gap when you don\\'t have a family doctor!",1),
     {type:"match",prompt:"Match the health term to its meaning",pairs:[["RAMQ","Quebec health insurance"],["ordonnance","doctor\\'s prescription"],["sans rendez-vous","walk-in, no appointment needed"],["renouveler","to renew"],["811","Info-Santé phone line"]],explain:"These 5 terms are the minimum for navigating Quebec healthcare in French. RAMQ card required for any covered service.",diff:1},
     wr("Write what you\\'d say when calling to make a medical appointment",["bonjour, je voudrais prendre rendez-vous","j\\'ai besoin de voir un médecin","est-ce que vous avez une disponibilité","j\\'ai ma carte RAMQ"],"Bonjour, je voudrais prendre rendez-vous avec un médecin, s\\'il vous plaît. J\\'ai quelques symptômes depuis quelques jours — ce n\\'est pas urgent. Est-ce que vous avez une disponibilité cette semaine? J\\'ai ma carte RAMQ.",1)]),

  mkL("b1-27","Housing & Tenant Rights in Quebec",30,"reading",
    "Quebec has strong tenant rights! Bail (lease): 12-month standard. Tribunal administratif du logement (TAL) = Rental Board. Key rights: 3 months notice for non-renewal, landlord responsible for repairs, dépôt (security deposit) is ILLEGAL in Quebec!",
    ["bail = lease (12 months standard)","loyer = rent / propriétaire = landlord","locataire = tenant","avis de non-renouvellement = 3 months notice required","Tribunal administratif du logement (TAL)","dépôt = deposit (ILLEGAL in Quebec!)","réparations = landlord\\'s responsibility","état des lieux = condition report","augmentation de loyer selon le TAL"],
    [mcq("Your Quebec landlord asks for a security deposit. You should know:",["This is required and normal","Security deposits are ILLEGAL in Quebec","You must pay two months\\' rent","Only required for commercial leases"],1,"Security deposits are ILLEGAL in Quebec residential leases! Only first month\\'s rent can be collected in advance. Report to the TAL if a landlord asks for a deposit!",2),
     {type:"scene",story:"Your lease ends June 30. On April 1, your landlord says you must leave and rent will increase 20%.",prompt:"What are your rights as a Quebec tenant?",options:["You must leave — the landlord can do this","The notice may be late (must be 3 months before = April 1 at latest) and 20% likely exceeds TAL formula — challenge both at the TAL","You must accept the increase but can negotiate the date","You have no rights"],correct:1,explain:"Two issues: (1) Non-renewal notice for June 30 must arrive by April 1 at the latest. (2) 20% increase almost certainly exceeds the TAL annual formula (typically 1-3%). Both can be challenged at the TAL!",diff:3},
     wr("Write a formal letter requesting a repair from your landlord",["je vous écris au sujet de","conformément au bail","je vous demande de bien vouloir","dans les meilleurs délais","à défaut de quoi"],"Monsieur,\\n\\nJe vous écris au sujet d\\'une réparation urgente. Le chauffage ne fonctionne plus depuis le 3 janvier. Conformément au bail, les réparations sont de votre responsabilité. Je vous demande d\\'y remédier dans les meilleurs délais. À défaut de quoi, je contacterai le Tribunal administratif du logement.",3)]),

  mkL("b1-28","Quebec Slang & Informal French",20,"speaking",
    "Essential Quebec expressions! DAILY: Ça a pas de bon sens! (That\\'s absurd!), C\\'est le boutte! (Awesome!), Avoir du fun, Pogner (to catch/get), Être tanné (fed up), Magasiner (shopping — Quebec), Jaser (to chat), Faque (so/therefore), Lâche pas! (Don\\'t give up!).",
    ["c\\'est le boutte = it\\'s awesome (Quebec)","avoir du fun = to have fun","pogner = to catch/get/be popular","être tanné(e) de = to be fed up with","magasiner = to go shopping (Quebec)","jaser = to chat informally","faque = so/therefore (Quebec)","chum = boyfriend/buddy","là = multi-use filler","tsé = tu sais (you know)","lâche pas! = don\\'t give up!"],
    [mcq("'Mon chum est vraiment le boutte!' In Quebec French:",["My enemy is annoying","My boyfriend is really awesome","My buddy is boring","My friend is confusing"],1,"Chum = boyfriend (or close male friend, context-dependent). Le boutte = awesome/the best. This is very Quebec — you\\'d never say this in France!",1),
     mcq("'Je suis tanné d\\'attendre!' means:",["I\\'m tangled","I\\'m tanned","I\\'m fed up with waiting","I\\'m tired of tanning"],2,"Être tanné(e) de = to be fed up with. Very common in everyday Quebec French!",1),
     {type:"scene",story:"You overhear: 'Coudonc, as-tu pogné le meeting de ce matin? Moé, j\\'étais tanné de jaser de ça, faque j\\'ai juste pris un café pis j\\'ai écouté.'",prompt:"What happened in this conversation?",options:["Someone missed the morning meeting","Someone attended the morning meeting reluctantly — was tired of the discussion, had coffee, and just listened","Someone got lost going to the meeting","Someone organized the meeting"],correct:1,explain:"Coudonc = anyway, pogné = caught/attended, moé = moi (Quebec pronunciation), tanné = fed up, jaser = talking, faque = so, pis = then. Translation: 'Anyway, did you catch the morning meeting? I was fed up talking about that, so I just had a coffee and listened.'",diff:2}]),

  mkL("b1-29","Writing a Structured Argument",35,"writing",
    "TEF Expression écrite requires a 200-word structured argument. TEMPLATE: Introduction (restate topic, announce plan) → Development (2-3 points with evidence) → Conclusion. KEY PHRASES: D\\'un côté... d\\'un autre côté, Il convient de souligner que, Prenons l\\'exemple de, En définitive, Force est de constater que, Il serait judicieux de.",
    ["Introduction: position + plan d\\'argumentation","Each point: idée → explication → exemple","D\\'un côté... d\\'un autre côté (balance two views)","il convient de souligner que (worth noting)","prenons l\\'exemple de (let\\'s take the example)","en définitive / en conclusion","force est de constater que","il serait judicieux de (it would be wise to)","Conclusion: restate + ouverture","200 mots minimum pour le TEF Canada"],
    [mcq("For TEF Expression écrite, which structure is MOST effective?",["Stream of consciousness — write everything you think","Introduction (position + plan) → 2-3 developed points with examples → Conclusion → 200+ words","Only examples, no opinion","A list of vocabulary words"],1,"Structured argumentation! TEF graders look for: clear position, organized development, examples/evidence, appropriate connectors, and a conclusion. A 3-part structure is the most reliable approach!",1),
     {type:"scene",story:"TEF task: 'Le télétravail devrait être une option permanente pour tous les travailleurs. Donnez votre opinion. (200 mots minimum)'",prompt:"Which introduction best starts this essay?",options:["Le télétravail c\\'est bien ou pas bien selon les gens.","La généralisation du télétravail est au cœur des débats actuels. Dans cet essai, je défendrai l\\'idée que le télétravail devrait être accessible à tous, bien que certaines conditions soient nécessaires pour garantir son efficacité.","Working from home is good.","I think télétravail is ok for some people maybe."],correct:1,explain:"Introduction B: announces the debate, states position, adds nuance (bien que + subjonctif), formal register. Never start with 'je pense que' in a formal TEF essay — too informal!",diff:2},
     wr("Write a 5-sentence introduction for the essay 'L\\'immigration est bénéfique pour le Canada.'",["l\\'immigration est au cœur de","dans cet essai, je soutiendrai que","d\\'une part","d\\'autre part","il convient d\\'examiner"],"L\\'immigration est au cœur du développement économique du Canada contemporain. Dans cet essai, je soutiendrai que l\\'apport des immigrants est indispensable à la vitalité du pays. D\\'une part, ils comblent des pénuries de main-d\\'œuvre. D\\'autre part, ils enrichissent la diversité culturelle. Il convient d\\'examiner ces deux dimensions pour comprendre les enjeux.",3)]),

  mkL("b1-30","Prepositions — Advanced Usage",25,"grammar",
    "Prepositions don\\'t translate directly! KEY: jouer DE (instruments) vs jouer À (sports), dépendre DE, tenir À, manquer À (reversed! Tu me manques = I miss you), se souvenir DE. City/country: à Paris, en France, au Canada, aux États-Unis, au Québec.",
    ["en France vs au Canada vs aux États-Unis","à Paris / à Montréal (cities: always à)","en voiture, en avion, à pied, à vélo","jouer du piano (DE) vs jouer au hockey (À)","dépendre de, tenir à, manquer à","se souvenir de, penser à","depuis (ongoing) vs il y a (completed past)","manquer à: Tu me manques = I miss YOU (reversed!)","en été, en hiver, en automne, au printemps"],
    [mcq("'Tu me manques' translates to:",["You are missing something","I miss you","You miss me","We miss each other"],1,"I miss you! Manquer À is reversed: the subject is what\\'s missed, the indirect object (me) is the one who misses. 'Tu me manques' = You are missed by me = I miss you. This confuses English speakers endlessly!",2),
     mcq("'Je joue ___ guitare et ___ tennis.'",["du, du","de la, au","à la, du","du, à la"],1,"Jouer DE + article for instruments: jouer de la guitare. Jouer À + article for sports: jouer au tennis. This rule has NO exceptions!",2),
     wr("Write 4 sentences about hobbies and habits using varied prepositions",["je joue de / au","je me déplace en / à","je pense souvent à","je me souviens de","en été / en hiver"],"Je joue de la guitare le soir après le travail. Je me déplace en métro et à vélo. Je pense souvent à ma famille restée dans mon pays. En hiver, je me souviens de la chaleur de mon pays — mais j\\'apprends à aimer la neige!",2)]),

  mkL("b1-31","Speaking About Culture & Identity",25,"speaking",
    "Key TEF oral topic! VOCABULARY: s\\'intégrer, s\\'adapter, s\\'enraciner (put down roots), appartenir à, préserver, identité culturelle, choc culturel, dépaysement, bilinguisme, multiculturalisme, valeurs, coutumes. NUANCE: entre deux cultures, je me sens à la fois... et..., je revendique mon identité, le vivre-ensemble québécois.",
    ["s\\'intégrer / s\\'adapter (integrate/adapt)","s\\'enraciner = to put down roots","appartenir à (to belong to)","identité culturelle / choc culturel","dépaysement (displacement feeling)","entre deux cultures","je me sens à la fois... et...","préserver ses traditions tout en s\\'adaptant","le vivre-ensemble québécois","revendiquer son identité"],
    [mcq("'Je me sens à la fois Québécois et Indien.' This expresses:",["confusion about identity","a hybrid/bicultural identity (both at once)","rejection of both cultures","a political statement"],1,"Bicultural identity! 'À la fois' = at the same time/both. This nuanced statement is what TEF graders look for — not simplistic either/or thinking. The Quebec 'vivre-ensemble' ideal embraces exactly this!",1),
     {type:"scene",story:"TEF oral: 'Comment vous êtes-vous intégré(e) au Québec? Parlez des défis et des aspects positifs.'",prompt:"Which answer best demonstrates B1 oral competency?",options:["It was hard. Now it\\'s OK. I learned French.","Je me suis intégré(e) progressivement, non sans difficultés. Le choc culturel et la barrière linguistique m\\'ont posé des défis. Avec le temps, j\\'ai appris à m\\'adapter tout en préservant mes traditions. Je me sens enraciné(e) au Québec, bien que nostalgique de ma culture d\\'origine.","Quebec is nice. People are helpful.","I don\\'t know how to answer this question."],correct:1,explain:"Response B: 'non sans difficultés' (elegant negation), 'choc culturel', 'm\\'adapter tout en préservant' (adapt while preserving — sophisticated), 'enraciné(e)', 'nostalgique de'. Personal, structured, nuanced. TEF oral gold!",diff:2},
     wr("Describe how your identity has evolved since coming to Canada in 4-5 sentences",["depuis que je suis arrivé(e)","progressivement","je me sens désormais","tout en restant","j\\'ai appris à","à la fois"],"Depuis que je suis arrivé(e) au Canada, mon identité s\\'est progressivement transformée. J\\'ai appris à m\\'adapter tout en restant fidèle à mes valeurs. Je me sens désormais à la fois Canadien(ne) et attaché(e) à ma culture natale. Cette dualité est devenue une force. Je suis fier/fière de porter cette double identité! 🍁",2)]),

  mkL("b1-32","Reading Government & Official Documents",30,"reading",
    "Decode bureaucratic French! Key documents: avis (notice), attestation (certificate), formulaire (form), convocation (summons/appointment). KEY PHRASES: en vertu de (pursuant to), conformément à (in accordance with), ci-joint (enclosed), à compter du (effective from), sous réserve de (subject to), veuillez noter que.",
    ["avis = notice/letter","attestation = official certificate","formulaire = form","convocation = official appointment/summons","en vertu de = pursuant to","conformément à = in accordance with","ci-joint = enclosed","à compter du = effective from","veuillez noter que = please note that","sous réserve de = subject to"],
    [mcq("'Conformément à votre demande, veuillez trouver ci-joint votre attestation.' This means:",["Send a new request","Your certificate is enclosed as you requested","Attend a meeting","Your request was refused"],1,"Conformément à (in accordance with) + ci-joint (enclosed) + attestation = the letter fulfills your request by enclosing the certificate. Standard Quebec government response format!",1),
     {type:"scene",story:"Letter: 'En vertu de l\\'article 12, vous êtes convoqué(e) à une entrevue le 22 mai à 9h30. Veuillez vous munir de votre pièce d\\'identité et de tous documents pertinents.'",prompt:"What must you do?",options:["Nothing — just information","Attend an immigration interview May 22 at 9:30am, bringing your ID and relevant documents","Send the letter back","Call to confirm"],correct:1,explain:"Convoqué(e) = summoned (mandatory, not optional!). Veuillez vous munir de = please bring. Missing a convocation can have serious consequences for your immigration file!",diff:2},
     wr("Write what you\\'d say when calling an office about a letter you received",["j\\'ai reçu un avis","je voudrais des renseignements concernant","pourriez-vous m\\'expliquer","j\\'ai une question concernant"],"Bonjour, j\\'ai reçu un avis de convocation daté du 10 avril. Je voudrais des renseignements concernant les documents à apporter. Pourriez-vous me confirmer l\\'adresse exacte du bureau? Merci beaucoup.",2)]),

  mkL("b1-33","French for the Workplace — Advanced",30,"speaking",
    "B1 workplace French: giving updates (À ce stade du projet...), asking for feedback (Quel est votre point de vue?), disagreeing politely (Si je puis me permettre..., J\\'aurais une réserve concernant...), managing deadlines (Je pourrais livrer ça pour le... / sauf imprévu).",
    ["donner une mise à jour: À ce stade du projet...","Si je puis me permettre... (formal disagreement opener)","J\\'aurais une réserve concernant... (formal hesitation)","Je pourrais livrer ça pour le...","En résumé / Pour récapituler","n\\'hésitez pas à me contacter","je reste disponible pour","sauf imprévu (barring unforeseen issues)"],
    [mcq("You disagree with your manager\\'s proposal. Most professional French response:",["'C\\'est complètement faux!'","'Si je puis me permettre, j\\'aurais quelques réserves concernant cette approche.'","'Non, je ne veux pas.'","'Maybe yes maybe no.'"],1,"Si je puis me permettre + j\\'aurais quelques réserves — exquisitely polite professional disagreement. Signals disagreement while respecting hierarchy. CLB 6 workplace hallmark!",1),
     {type:"scene",story:"In a team meeting, your manager asks: 'Où en êtes-vous avec le rapport mensuel?'",prompt:"Best B1 professional response:",options:["Not done yet.","Je voulais justement vous en parler. À ce stade, la collecte des données est terminée. Il me reste à rédiger l\\'analyse. Je prévois de livrer le document d\\'ici vendredi, sauf imprévu.","I don\\'t know.","The report is in progress."],correct:1,explain:"Response B: 'je voulais justement' + 'à ce stade' + specific progress update + 'il me reste à' + delivery date + 'sauf imprévu'. Complete, professional, B1 workplace French!",diff:2},
     wr("Write a professional email to your team with a project update",["je vous contacte pour faire le point","à ce stade du projet","les prochaines étapes sont","sauf imprévu","je reste disponible"],"Objet: Mise à jour — Projet intégration\\n\\nBonjour à toutes et à tous,\\n\\nJe vous contacte pour faire le point. À ce stade, la phase de développement est complétée à 80%. Les prochaines étapes: tests (semaine 3) et livraison (semaine 4), sauf imprévu.\\n\\nJe reste disponible pour toute question.\\n\\nCordialement",2)]),

  mkL("b1-34","Comparatives & Superlatives — Advanced",20,"grammar",
    "Irregular comparatives: bon → meilleur (better adj), bien → mieux (better adverb), mauvais → pire (worse). DOUBLE: plus... plus... (the more... the more), de plus en plus (more and more), de moins en moins (less and less). SPECIAL: d\\'autant plus que (all the more because).",
    ["bon → meilleur (better, adj)","bien → mieux (better, adverb)","mauvais → pire (worse)","le meilleur / le pire","plus... plus... (the more... the more)","d\\'autant plus que (all the more so because)","de moins en moins (less and less)","de plus en plus (more and more)","autant que (as much as)"],
    [mcq("'Ce restaurant est bon, mais l\\'autre est ___ (better).'",["plus bon","meilleur","mieux","le meilleur"],1,"Meilleur = better (adjective — modifies a noun). 'Mieux' = better (adverb — modifies a verb). 'Ce restaurant est meilleur.' vs 'Il cuisine mieux.' This distinction is tested heavily in TEF!",1),
     mcq("'Plus on pratique le français, ___ on progresse.'",["plus","moins","mieux","autant"],2,"Plus on pratique, MIEUX on progresse. When the second clause describes quality of action, use 'mieux' (adverb). Compare: 'plus on mange, plus on grossit' vs 'plus on pratique, mieux on parle'.",2),
     wr("Write 3 sentences comparing your French now vs when you arrived",["de plus en plus","d\\'autant plus que","bien mieux qu\\'avant","le meilleur moyen est"],"Je parle bien mieux qu\\'à mon arrivée. Je comprends de plus en plus les conversations rapides, d\\'autant plus que j\\'écoute la radio chaque matin. Le meilleur moyen de progresser reste la pratique quotidienne.",1)]),

  mkL("b1-35","Environmental & Social Topics",25,"speaking",
    "TEF oral often covers social topics. ENVIRONMENTAL: changement climatique, transition écologique, énergie renouvelable, empreinte carbone, développement durable, biodiversité. SOCIAL: inégalité, équité, logement abordable, itinérance (homelessness — Quebec). Quebec-specific: Hydro-Québec, Plan Nord, crise du logement.",
    ["changement climatique / réchauffement planétaire","transition écologique","énergie renouvelable","empreinte carbone = carbon footprint","développement durable = sustainable development","inégalité / équité","logement abordable = affordable housing","itinérance = homelessness (Quebec)","Hydro-Québec / Plan Nord","crise du logement = housing crisis"],
    [mcq("Quebec uses 'itinérance' to describe:",["mountain hiking","homelessness","immigration","tourism"],1,"Itinérance = homelessness (the state of having no fixed abode). Quebec-specific term used in official documents and social services. In France, 'SDF' (sans domicile fixe) is more common.",1),
     {type:"scene",story:"TEF oral prompt: 'Selon vous, quels sont les principaux défis environnementaux auxquels fait face le Québec?'",prompt:"Which response demonstrates B1 oral mastery?",options:["Quebec has some environmental problems.","Le Québec fait face à plusieurs défis majeurs. La transition vers une économie durable reste incomplète, malgré les progrès d\\'Hydro-Québec. La crise climatique menace la biodiversité nordique. À mon avis, le Plan Nord pourrait être une opportunité de développement durable, à condition d\\'intégrer les préoccupations des communautés autochtones.","Environment is a big problem everywhere.","I don\\'t know much about Quebec environment."],correct:1,explain:"Response B: specific (Hydro-Québec, Plan Nord, biodiversité nordique, communautés autochtones), structured, nuanced (à condition de), formal vocabulary. This is CLB 6 speaking!",diff:3},
     wr("Express your opinion on affordable housing in Quebec in 4-5 sentences",["la crise du logement","il me semble que","les autorités devraient","d\\'un côté","d\\'un autre côté","j\\'estime que"],"La crise du logement au Québec est une réalité alarmante. Il me semble que les autorités devraient investir davantage dans le logement social. D\\'un côté, les loyers augmentent plus vite que les salaires. D\\'un autre côté, les projets de construction manquent de financement. J\\'estime qu\\'il est indispensable d\\'agir maintenant.",2)]),

  mkL("b1-36","Pronoms Relatifs — Advanced (dont, lequel)",25,"grammar",
    "DONT (of which/whom): replaces de + noun. LEQUEL/LAQUELLE: used after prepositions other than de. AUQUEL (à + lequel contracted). CE QUI / CE QUE / CE DONT: 'Ce qui m\\'intéresse' (what interests me), 'Ce que j\\'aime' (what I like), 'Ce dont j\\'ai besoin' (what I need).",
    ["dont = replaces de + noun in relative clause","lequel/laquelle (after prepositions + de)","auquel/auxquels (à + lequel contracted)","pour lequel / dans lequel / sur lequel","ce qui (subject: what interests me)","ce que (object: what I like)","ce dont (object of de: what I need)","dont vs de qui: dont preferred unless ambiguous"],
    [mcq("'C\\'est le projet ___ je suis le plus fier.' Correct pronoun:",["que","qui","dont","lequel"],2,"Dont — because 'être fier DE'. The relative pronoun replaces 'de + project'. Dont is triggered by verbs taking de: se souvenir de, avoir besoin de, parler de, être fier de.",2),
     mcq("'La raison ___ je suis venu au Canada est économique.' Correct pronoun:",["que","dont","pour laquelle","qui"],2,"Pour laquelle — 'pour' + 'laquelle' (feminine). The preposition 'pour' must be kept with the lequel form. 'Dont' only works if the verb takes 'de'. 'Les raisons pour lesquelles' = the reasons why.",3),
     wr("Write 3 sentences about Canada using dont, lequel, and ce que",["le pays dont je suis","la ville dans laquelle","ce que j\\'apprécie le plus","ce dont j\\'ai besoin"],"Le Canada est le pays dont je suis fier d\\'être résident permanent. Montréal est la ville dans laquelle je me suis enraciné. Ce que j\\'apprécie le plus ici, c\\'est la diversité culturelle et l\\'accès aux services publics.",3)]),

  mkL("b1-37","Telephone & Digital Communication",20,"speaking",
    "Phone French! FORMULAS: 'Allô?' (Quebec hello on phone), 'Ici [nom]' (This is [name]), 'Ne quittez pas' (Hold on), 'Je vous le/la passe' (I\\'ll put them on), 'Voulez-vous laisser un message?'. VOICEMAIL: boîte vocale, après le bip. DIGITAL: courriel (email — Quebec), texto, visioconférence.",
    ["Allô? = phone greeting (Quebec)","Ici [nom] = This is [name] (phone)","Ne quittez pas = Hold on / Please hold","Je vous le/la passe = I\\'ll put them on","Voulez-vous laisser un message?","boîte vocale = voicemail","après le bip = after the beep","courriel = email (Quebec/formal)","texto / message texte = text message","visioconférence = video conference"],
    [mcq("You hear: 'Madame Tremblay est absente. Voulez-vous laisser un message?' You should:",["Call back without message","Leave a message with name, number, and reason for calling","Hang up immediately","Ask for a different person"],1,"Leave a message with: name, phone number, reason for calling, and when you\\'re available for a callback. Standard Quebec phone etiquette!",1),
     {type:"scene",story:"The beep sounds. You need to confirm your RAMQ card renewal appointment.",prompt:"Which voicemail message is best?",options:["Um... hi... call me back... bye.","Bonjour. Ici Jean-Pierre Dupont. Je vous appelle au sujet du renouvellement de ma carte RAMQ. Mon numéro est le 514-555-0193. Je suis disponible en semaine entre 9h et 17h. Merci et bonne journée.","I need my health card renewed please call me.","This is Jean. Call me."],correct:1,explain:"Response B: name (Ici = This is), purpose (sujet du renouvellement), phone number, availability, polite closing. Every element is there. Quebec voicemail gold standard!",diff:1},
     wr("Write a script for leaving a professional voicemail about a job application follow-up",["bonjour, ici","je vous contacte pour faire suite à","j\\'ai soumis ma candidature","je reste joignable au","bonne journée"],"Bonjour, ici Amara Diallo. Je vous contacte pour faire suite à ma candidature au poste de comptable soumise le 5 avril. Je souhaitais m\\'assurer que vous l\\'avez bien reçue. Je reste joignable au 438-555-0721, du lundi au vendredi. Bonne journée!",2)]),

  mkL("b1-38","Quebec Expressions & Idioms",20,"vocabulary",
    "Authentic Quebec expressions: Ça a pas d\\'allure! (That\\'s absurd!), Être dans le jus (swamped), Prendre une marche (go for a walk — Quebec), En masse (a lot/together), Tantôt (earlier OR soon — context!), À soir (ce soir), Faire du pouce (hitchhike), Lâche pas! (Don\\'t give up!)",
    ["ça a pas d\\'allure = that\\'s absurd/wrong","être dans le jus = to be swamped","prendre une marche = to go for a walk (Quebec)","en masse = a lot/all together (Quebec)","tantôt = earlier OR soon (context-dependent!)","à soir = ce soir (Quebec)","faire du pouce = to hitchhike","lâche pas! = don\\'t give up!","être à bout = to be exhausted"],
    [mcq("'Je suis dans le jus ce matin!' means:",["They are swimming","They are very busy/swamped","They are drinking juice","They are lost"],1,"Être dans le jus = to be swamped with work. Very Quebec! You might respond: 'Peux-tu me dire tantôt si t\\'as une minute?' — combining two Quebec expressions!",1),
     mcq("'Lâche pas!' is a Quebec expression meaning:",["Let go!","Drop it!","Don\\'t give up!","Stop talking!"],2,"Lâche pas! = Don\\'t give up! (literally: don\\'t let go!). Common Quebec encouragement at sporting events and when someone faces challenges.",1),
     {type:"scene",story:"You hear: 'À soir, on prend une marche en masse pis après on va passer au cash au resto du coin. T\\'es là?'",prompt:"What are they planning?",options:["Working late tonight","Tonight: a walk together, then eating at the nearby restaurant — are you in?","Taking a cash break","Going to the corner store"],correct:1,explain:"À soir = ce soir (tonight), prendre une marche (Quebec walk), en masse = all together, passer au cash = pay at a restaurant, du coin = nearby, t\\'es là? = are you in? A fully Quebec social invitation!",diff:2}]),

  mkL("b1-39","Formal Writing — Letters & Reports",35,"writing",
    "B1 formal writing: REPORT STRUCTURE: Introduction/objet → Constat (findings) → Analyse → Recommandations → Conclusion. FORMAL MARKERS: Suite à (following), Je soussigné(e) (I the undersigned), ci-joint (enclosed), Pour faire valoir ce que de droit (to whom it may concern — attestation closing).",
    ["Suite à = following/further to","Je soussigné(e) = I the undersigned","objet: specific purpose line","Constat = observations/findings","Recommandations = formal recommendations","Pour faire valoir ce que de droit (attestation closing)","lettre de réclamation (complaint letter)","lettre de motivation = cover letter","Fait à [ville], le [date] (signature line)","Veuillez agréer... (formal closing)"],
    [mcq("'Pour faire valoir ce que de droit.' means:",["This letter is worth something","To whom it may concern / for use as required by law","Please verify this document","The letter is for public use only"],1,"Pour faire valoir ce que de droit = for use as required / to whom it may concern. Standard closing on attestations and formal certificates in Quebec official French!",2),
     {type:"scene",story:"You write a complaint to your internet provider — service down 5 days, bill not adjusted.",prompt:"Which letter structure is correct for a formal complaint?",options:["Hi, my internet doesn\\'t work. Fix it.","Objet: Réclamation — Interruption de service du 10 au 15 avril\\n\\nMadame, Monsieur,\\n\\nSuite à une interruption de cinq jours consécutifs, je vous adresse la présente réclamation. Conformément à mon contrat, je vous demande un crédit proportionnel sur ma prochaine facture. Dans l\\'attente de votre réponse...","Internet broken please fix","Service problème depuis 5 jours."],correct:1,explain:"Response B: Objet (specific), Suite à (following), five consecutive days (precise), conformément au contrat (legal grounding), crédit proportionnel (specific demand), formal opening/closing. CLB 6 complaint letter quality!",diff:2},
     wr("Write a formal complaint email about a billing error",["objet: réclamation","suite à","je me permets de vous signaler","il semblerait que","je vous saurais gré de","dans les meilleurs délais"],"Objet: Réclamation — Erreur de facturation\\n\\nMadame, Monsieur,\\n\\nSuite à la réception de ma facture du 1er avril, je me permets de vous signaler une anomalie. Il semblerait qu\\'une somme de 45,00$ ait été débitée deux fois. Je vous saurais gré de corriger cette erreur dans les meilleurs délais et de me faire parvenir une facture rectifiée.\\n\\nCordialement",3)]),

  mkL("b1-40","B1 Final Review — CLB 5-6 Integration",35,"mixed",
    "You have completed B1 — CLB 5-6 equivalent! This is the threshold for most permanent residency pathways and the TEF Canada passing level. You command: complex tenses (PQP, conditionnel passé, subjonctif), advanced relative pronouns (dont, lequel, ce que/dont), sophisticated argument structure, professional and formal register, Quebec cultural and bureaucratic French. B2 (CLB 7-8) opens Express Entry and citizenship. You are ready!",
    ["B1/CLB 5-6 = handle most everyday + professional situations","TEF Canada CLB 5 = minimum for many citizenship applications","CLB 6 = strong TEF pass, many PR pathways","Subjonctif: doubt, emotion, necessity, concession","Conditionnel passé: past regrets, type-3 conditionals","Dont: replaces de + noun in relative clause","Lequel: after prepositions other than de","Formal register: key for TEF writing and speaking","Professional emails: objet, formule d\\'appel, closing","B2 opens: Express Entry CLB 7, advanced academic French"],
    [mcq("CLB 5-6 level means you can:",["Only introduce yourself","Handle most everyday situations, express opinions, write structured texts, and understand extended conversations","Reach native-level fluency in all situations","Only read simple texts"],1,"CLB 5-6 = handle most everyday + professional situations, express and justify opinions, write 200-word structured arguments, understand main ideas and details in extended listening. This is what you\\'ve now achieved!",1),
     {type:"match",prompt:"Match the B1 structure to its key rule",pairs:[["Subjonctif","after doubt, emotion, necessity — douter que, bien que, il faut que"],["Conditionnel passé","si + PQP → would have done (past hypothetical)"],["Dont","replaces de + noun in a relative clause"],["Lequel","used after prepositions other than de"],["Registre soutenu","required for TEF writing and speaking"]],explain:"These 5 structures define B1 competency. Subjonctif = after doubt/emotion/necessity; conditionnel passé = past regrets and type-3; dont = de + noun replacement; lequel = preposition + relative pronoun; registre soutenu = TEF essential!",diff:2},
     {type:"scene",story:"TEF oral: 'Pensez-vous que le bilinguisme est un avantage sur le marché du travail canadien?'",prompt:"Which introduction demonstrates complete B1 oral mastery?",options:["Bilinguisme is good for work. Yes I think so.","La question du bilinguisme sur le marché du travail est particulièrement pertinente dans mon parcours. Je suis convaincu que maîtriser le français et l\\'anglais constitue un avantage concurrentiel indéniable, d\\'autant plus que le Canada valorise officiellement les deux langues. Permettez-moi de développer cette idée avec des exemples concrets.","I have no opinion on bilingualism.","Bilingualism is required in Canada."],correct:1,explain:"Response B: 'particulièrement pertinente dans mon parcours' (personal + relevant), 'je suis convaincu que' (B1 certainty marker), 'avantage concurrentiel indéniable' (professional vocabulary), 'd\\'autant plus que' (sophisticated connector), 'permettez-moi de développer' (classic oral structure announcement). Five B1 markers in three sentences!",diff:3},
     wr("Write your B1 achievement statement: what you can do now that you couldn\\'t before",["je suis désormais capable de","je maîtrise","je peux m\\'exprimer","grâce à l\\'étude du B1","j\\'ai développé","je suis prêt(e) à"],"Grâce à l\\'étude du niveau B1, je suis désormais capable de m\\'exprimer avec confiance dans la plupart des situations professionnelles. Je maîtrise les structures complexes: subjonctif, conditionnel passé, pronoms relatifs avancés. J\\'ai développé un registre formel adapté au TEF Canada. Je suis prêt(e) pour la prochaine étape. 🍁",3)]),
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
     mcq("If you lose your train of thought at 3 minutes into a 5-minute monologue, you should:",["stop completely and apologize","switch to your native language","use a filler phrase to reconnect: 'C'est dans cette optique que...' / 'Comme je le mentionnais...'","start over from the beginning"],2,"Recovery phrases! 'C'est dans cette optique que...' / 'Il convient à présent d'examiner...' / 'J'en reviens ainsi à ma thèse centrale...' — these reconnect your argument after a moment of loss. Assessors don't penalize brief hesitation; they notice HOW you recover. Recovery = sign of advanced competence!"),
     wr("Write a 30-second contextualization for: 'L'IA va-t-elle remplacer les travailleurs?'",["la question de l'intelligence artificielle","dans un contexte de","face aux avancées technologiques","cette problématique","il convient de s'interroger"],"Dans un contexte de transformation technologique accélérée, la question de l'impact de l'intelligence artificielle sur le marché du travail s'impose comme l'un des grands enjeux économiques et sociaux de notre époque. Face aux avancées spectaculaires de l'IA générative, il convient de s'interroger sur les véritables implications pour l'emploi humain. — ~45 words, perfect B2 contextualization!")]),

  mkL("b2-17","Speaking: Debate & Argumentation",25,"speaking",
    "Advanced debate skills at B2 level — for TEF speaking and professional contexts! Beyond CLB 6 (justify your position), B2 debate: anticipate objections proactively, use rhetorical questions effectively, cite data/studies, appeal to shared Canadian values, and 'reframe' the debate when needed. Reframing: 'La vraie question n'est pas X, mais Y.' Building on opponent: 'Vous avez raison sur X, cependant...' Conceding a point strategically: 'Je vous accorde ce point, toutefois...'",
    ["Anticiper: 'On pourrait objecter que... mais...'","Reframer: 'La vraie question est...'","Citation de données: 'Selon une étude de...'","Valeurs canadiennes: multiculturalisme, inclusion","Je vous accorde ce point, toutefois... (I grant you that, however)","Vous avez raison sur X, mais il n'en demeure pas moins que...","Question rhétorique: 'N'est-il pas évident que...?'","Conclure avec un appel à l'action ou valeur partagée"],
    [mcq("'La vraie question n'est pas X, mais Y' is a technique called:",["concession","reframing the debate","giving up your argument","asking a rhetorical question"],1,"Reframing = shifting the terms of the debate to more favorable ground. 'La vraie question n'est pas de savoir si l'immigration coûte cher, mais de mesurer ses contributions nettes à long terme.' This changes what's being debated — a sophisticated debate move!"),
     mcq("Citing 'Selon une étude de l'Université de Montréal' in a debate:",["is irrelevant to spoken debate","weakens your argument","adds credibility through external authority (logos + éthos)","is only for written essays"],2,"Citing studies/data = logos + éthos (logic + credibility through authority). In spoken French debates, citing sources strengthens your argument significantly. 'Des recherches récentes démontrent que...' / 'Selon les données de Statistiques Canada...' — even if you can't cite exactly, showing awareness of evidence is B2+!"),
     wr("Strategically concede a point then pivot to your main argument",["je vous accorde","certes, vous avez raison sur","c'est un point valide, cependant","je comprends cet argument, toutefois","il est vrai que... néanmoins"],"Je vous accorde que l'intégration des immigrants représente un défi réel pour les services publics à court terme. Il n'en demeure pas moins que, sur une période de 10 à 20 ans, les données économiques démontrent systématiquement que l'immigration génère des bénéfices nets considérables pour le Canada. — Strategic concede + data-backed pivot!")]),

  mkL("b2-18","Speaking: Register Control Practice",25,"speaking",
    "Demonstrate full register control in speaking — from formal to informal and back! B2 competency: you can consciously choose your register and shift it appropriately. Practice: same content, 3 registers. Formal (interview): 'Je me spécialise dans le domaine de la santé publique.' Standard (colleague): 'Je travaille dans la santé publique.' Informal (friend): 'Ouais, je travaille dans la santé, genre les politiques de santé.' The test: can you code-switch naturally and purposefully?",
    ["Registre formel: lexique soutenu, syntaxe élaborée","Registre courant: standard, quotidien professionnel","Registre familier: contractions, argot léger","Code-switching = adapter selon l'interlocuteur","Marqueurs formels: je ne saurais, il convient, nonobstant","Marqueurs informels: ouais, ben, pis, ça fait que","L'accent québécois n'est PAS un registre familier!","Test: même idée, 3 registres différents"],
    [mcq("Code-switching in language means:",["making errors in two languages","consciously adapting your register to the context and audience","switching entirely to another language","speaking incorrectly"],1,"Code-switching = consciously adapting your language register (not necessarily your language!) to the context. Using formal French in a job interview and informal French with friends is code-switching. It's a sign of linguistic sophistication — not confusion!"),
     mcq("In a professional Quebec workplace, the appropriate register is:",["très familier — Quebec argot only","très soutenu — like a formal essay","courant/standard — professional but not overly formal","literary French — like 19th century novels"],1,"Standard/professional register for Quebec workplaces. Not overly formal (stiff), not informal (inappropriate). 'Pourriez-vous m'envoyer ce document?' not 'File me ton doc.' Not 'Je vous serais infiniment reconnaissant de bien vouloir me faire parvenir ledit document' either — too formal for daily emails!"),
     wr("Say 'I'm exhausted after this long meeting' in 3 different registers",["je suis épuisé après cette longue réunion (courant)","cette réunion m'a complètement éreinté (soutenu)","je suis vraiment crevé après cette réunion (familier)"],"Formel: Cette réunion prolongée m'a particulièrement épuisé. Courant: Je suis vraiment fatigué après cette longue réunion. Familier: Ah là là, je suis complètement crevé après cette réunion-là! — Three registers, same idea. B2 = you can produce all three on demand!")]),

  mkL("b2-19","Listening: Authentic Radio/Podcast French",30,"listening",
    "Understand authentic French media at B2/CLB 7 level! Key resources: Radio-Canada (Ici Radio-Canada Première), Espaces.ca, RFI Savoirs, Plus on est de fous plus on lit (CBC Radio). Challenges: fast speech, overlap, Quebec accent, cultural references, idioms. Strategy: 1) Listen 2-3 times minimum. 2) First listen: topic and general structure. 3) Second listen: main points. 4) Third listen: details and evidence. 4) Note idioms and new vocabulary.",
    ["Ressources: Radio-Canada, RFI, ICI Première","Stratégie d'écoute multi-passages","Première écoute: thème général","Deuxième écoute: points principaux","Troisième écoute: détails et nuances","Accent québécois: 'pis' = et puis, 'ben' = bien","Expressions idiomatiques québécoises","Repérer les invités, leurs opinions, leurs arguments"],
    [mcq("In Quebec French radio, 'pis' is a contraction of:",["puis seulement","et puis/puis (and then)","oui pis non","pas"],1,"Pis = et puis / puis (informal: and then / also). Very common in spoken Quebec French: 'J'suis allé au dépanneur, pis après j'suis revenu.' You'll hear this constantly on Radio-Canada informal segments. Understanding 'pis' is essential for following natural Quebec speech!"),
     mcq("Listening to a radio debate, you should first identify:",["every single word spoken","the speakers' identities and their positions on the topic","only the host's questions","only the statistics mentioned"],1,"First: identify the speakers and their positions. Then: their arguments and evidence. A 5-minute radio debate has too much content to capture everything — prioritize: WHO believes WHAT and WHY. Then fill in supporting details on subsequent listens."),
     wr("Name 2 French-language media resources in Canada you'll use for practice",["radio-canada","ici radio-canada première","le devoir","la presse","journal de montréal","le soleil","tv5","rdi"],"Radio-Canada / Ici Radio-Canada Première + Le Devoir or La Presse. Radio-Canada is the public broadcaster — excellent quality, clear pronunciation, diverse topics. Le Devoir is serious journalism. Journal de Montréal is more popular/accessible. Use all levels of media!")]),

  mkL("b2-20","Listening: Conference & Lecture French",25,"listening",
    "Understand conference presentations and academic lectures at B2 level! Structure of academic French presentations: annonce du plan (outline), développement par points (main points), transitions (passons maintenant à, j'aborde à présent), récapitulatif (summary), conclusion et ouverture (conclusion and opening to questions). Key vocabulary: la problématique (issue/research question), le cadre théorique (theoretical framework), les données empiriques (empirical data), les résultats (results/findings).",
    ["Annonce du plan: 'Je vais aborder trois points...'","Transition: 'Passons maintenant à...'","Récapitulatif: 'En résumé, nous avons vu que...'","Ouverture: 'Cela soulève la question de...'","la problématique (research question/issue)","les données (data)","les résultats / les conclusions (results/conclusions)","selon les recherches de... (according to research by...)","il convient de nuancer (one should nuance this)"],
    [mcq("'Je vais vous présenter trois points principaux.' In a lecture, this signals:",["the conclusion","the introduction/plan announcement","a transition","a question from the audience"],1,"Plan announcement = the speaker tells you the structure in advance. Listen carefully and use it as a roadmap! 'Trois points' = you'll take 3 sets of notes. Academic speakers in French always announce their structure — use it to organize your comprehension!"),
     mcq("'Cela soulève la question de...' in a lecture means:",["this answers the question of...","this raises/opens up the question of...","this resolves the question of...","this ignores the question of..."],1,"Soulever une question = to raise a question (not answer it — to open it up for consideration). Often used in conclusions to invite reflection: 'Nos résultats soulèvent la question de l'efficacité à long terme de ces politiques.' Shows intellectual openness at B2+!"),
     wr("Write a transition sentence moving from point 1 to point 2 in a presentation",["passons maintenant à","j'aborde à présent","après avoir examiné","nous avons vu que","je me penche à présent sur"],"Après avoir examiné les défis linguistiques des immigrants au Canada, j'aborde à présent les solutions proposées par les experts et les politiques gouvernementales en place. — Perfect academic transition: summarizes point 1 briefly, introduces point 2, connects them logically. CLB 7 presentation language!")]),

  mkL("b2-21","Reading: Complex Literary/Academic Text",25,"reading",
    "Read complex texts at B2/CLB 7 level! Types: scholarly articles (articles scientifiques), opinion pieces (chroniques, éditoriaux), literary excerpts (extraits littéraires), policy documents. Strategies: 1) Identify text type and purpose. 2) Note structure (introduction-development-conclusion). 3) Distinguish facts, opinions, and inferences. 4) Infer meaning of unknown words from context. 5) Identify the author's stance (nuanced? partisan? objective?). Key skill: reading critically, not just for information.",
    ["Type de texte: identifier d'abord","But de l'auteur: informer, persuader, analyser?","Fait vs opinion vs inférence","Point de vue de l'auteur: neutre, partial, engagé?","Vocabulaire par contexte (déduction)","Structure: thèse, antithèse, synthèse","Registre: soutenu, académique, journalistique","Question critique: 'À qui s'adresse ce texte?'"],
    [mcq("When you encounter an unknown academic word, your first strategy should be:",["stop reading","look it up immediately","use context (surrounding words) to infer the meaning","skip it entirely"],2,"Context first! Academic texts are full of specialized vocabulary. Use: the sentence structure, surrounding words, text topic, cognates (similar words in another language you know). Only look up a word if it's essential to understanding the main argument. This saves time in timed tests!"),
     mcq("A text is 'partial' (partial) when:",["it covers only half the topic","it's incomplete","the author presents a biased viewpoint (taking sides)","it's written in parts"],2,"Partial (un texte partial) = biased, taking one side. 'Partiel' = incomplete (only covers part). False cognate alert! 'Cet article est partial — l'auteur ne présente que les arguments en faveur de sa thèse.' vs 'Cette analyse est partielle — elle n'examine qu'un aspect du problème.'"),
     wr("Write a critical observation about a text you recently read",["l'auteur soutient que","ce texte défend la thèse","il convient de noter que","bien que l'argument soit","force est de constater"],"Bien que l'auteur soutienne une thèse convaincante sur l'importance du bilinguisme au Canada, force est de constater que son analyse demeure partielle, car elle néglige les réalités des communautés francophones hors Québec. — Critical reading response at CLB 7+ level!")]),

  mkL("b2-22","Reading: News Analysis",25,"reading",
    "Critically analyze French-language news at B2 level! Beyond comprehension: identify framing (cadrage), implicit assumptions (présupposés), emotional language (langue émotionnelle), political bias (biais politique), omissions (ce qui n'est pas dit — what's NOT said). Quebec media landscape: La Presse (centrist/online), Le Devoir (intellectual), Journal de Montréal (populaire/conservative), Radio-Canada (public). Critical reading = essential for informed citizenship in Canada!",
    ["Le cadrage (framing) d'un article","Les présupposés implicites (implicit assumptions)","Langue émotionnelle vs neutre","Identifier les sources citées et leur fiabilité","Ce qui n'est PAS dit (omissions)","La Presse vs Le Devoir vs Journal de Montréal","Biais: lexique choisi révèle la position","Question: à qui profite cet article?"],
    [mcq("'Les immigrants envahissent le marché du travail' vs 'Les immigrants contribuent au marché du travail.' The difference is:",["only vocabulary","only punctuation","framing and emotional language (même sujet, perspective opposée)","length only"],2,"Same topic (immigrants in the labor market) but completely opposite framing through word choice. 'Envahissent' = invade (negative, threatening), 'contribuent' = contribute (positive, constructive). Word choice reveals ideology — critical reading means noticing this!"),
     mcq("'It goes without saying that' in a text often signals:",["a neutral observation","a hidden assumption presented as obvious","a fact with evidence","a question"],1,"Presenting something as obvious ('il va sans dire que', 'évidemment', 'bien entendu') is a rhetorical technique that embeds assumptions without defending them. Critical readers notice these 'it goes without saying' claims and ask: does it really? For whom? Why?"),
     wr("Identify one implicit assumption in this headline: 'Les immigrants coûtent cher à l'État'",["cette affirmation","la phrase suppose que","le titre implique que","le présupposé est que","cette affirmation ignore"],"Ce titre implique que les immigrants reçoivent plus de l'État qu'ils n'y contribuent, ce qui est un présupposé discutable. Des études montrent en réalité que l'immigration génère des bénéfices économiques nets à long terme. — Critical reading + counter-evidence = CLB 7-8 analytical skill!")]),

  mkL("b2-23","TEF Canada: Listening Strategy",30,"listening",
    "TEF Canada listening section: 3 parts, increasing difficulty. Part 1: 5 short recordings (everyday messages, ~1 min each). Part 2: 4 longer recordings (interviews, news — ~2-3 min each). Part 3: 2 long recordings (conference, debate — ~4-5 min each). 40 questions total, 40 minutes. Strategy: read questions BEFORE each audio, take notes (provided paper), answer immediately — you hear each recording ONCE (no replay in TEF!). Quebec accent throughout!",
    ["TEF: 3 parties (difficultés croissantes)","Partie 1: courts messages (everyday)","Partie 2: enregistrements moyens (interviews, nouvelles)","Partie 3: longs enregistrements (conférence, débat)","40 questions en 40 minutes","Écoute UNIQUE — pas de réécoute!","Lire les questions AVANT l'audio","Prise de notes sur papier fourni","Accent québécois tout au long"],
    [mcq("In the TEF Canada listening section, each recording is heard:",["once only","twice","three times","you can replay as needed"],0,"Once only — no replay in TEF! This is the biggest difference from practice exercises. You must: 1) Read questions BEFORE listening, 2) Take notes DURING (keywords, numbers, names), 3) Answer IMMEDIATELY after. Practice with Radio-Canada without replay to simulate test conditions!"),
     mcq("The best note-taking strategy during TEF listening:",["write every word you hear","write only question numbers","write keywords, numbers, names, and key phrases — not full sentences","do not take notes to stay focused"],2,"Keywords + numbers + names + key phrases = efficient notes. Full sentences = impossible at normal speech speed. 'Médecin, 15 mars, 10h30, annuler, rappeler 514-xxx' is more useful than 'The doctor called to say the appointment on March 15 at 10:30 is cancelled please call back.' Speed and accuracy over completeness!"),
     wr("List 3 things you'll do before each TEF listening audio plays",["lire les questions","identifier les mots-clés","préparer mon papier de notes","rester concentré","noter les options de réponse"],"1) Je lis toutes les questions de cette section. 2) J'identifie les mots-clés dans chaque question (date? lieu? opinion?). 3) Je prépare ma feuille de notes et me concentre. — 3-step pre-listening routine. Do this every time in practice to make it automatic for test day!")]),

  mkL("b2-24","TEF Canada: Speaking Tasks",30,"speaking",
    "TEF Canada expression orale: 2 tasks recorded at a test centre. Task 1: describe/explain (15 min preparation, 8-10 min recording). Task 2: give opinion/debate (15 min preparation, 8-10 min recording). Assessment: range and accuracy of expression, vocabulary, coherence/organization, fluency, pronunciation. Preparation strategy: notes are allowed during prep time. Structure your response FIRST on paper, then record. Quebec accent is perfectly acceptable!",
    ["TEF: 2 tâches d'expression orale","Tâche 1: décrire/expliquer (narratif)","Tâche 2: donner son opinion/débattre","15 minutes de préparation par tâche","8-10 minutes d'enregistrement","Plan sur papier pendant la préparation","Critères: gamme, précision, cohérence, aisance, prononciation","L'accent québécois est parfaitement acceptable!","Commencer fort, conclure fort"],
    [mcq("During TEF speaking preparation time, you should:",["memorize a prepared speech on the topic","read a script word for word","structure your response with bullet points and key vocabulary","sit quietly without taking notes"],2,"Use every second of prep time! Write: thesis (position), 3-4 main points, key vocabulary, examples, transition words, conclusion. Then record using your notes. You can glance at notes during recording — it's allowed! Structured = higher score."),
     mcq("TEF speaking is assessed on pronunciation:",["must be native-like","Quebec accent is not accepted","Quebec or standard French accent are both acceptable","only European French accent"],2,"Quebec accent = perfectly acceptable! TEF Canada is Canadian — Quebec French is the norm here. What matters: clarity, being understood, not the specific accent. 'Pis', 'tsé', 'ouais' in very informal register might be penalized, but a natural Quebec French accent is not!"),
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
     mcq("If you're uncertain about a TEF question, you should:",["leave it blank","spend as much time as needed","eliminate obviously wrong answers, make your best guess, move on","go back to the beginning"],2,"Never leave blank! Wrong answer = 0 points. Blank = 0 points. Best guess after elimination = chance at 1 point. Eliminate clearly wrong options, choose from what remains, mark the question, and MOVE ON. Return at the end if you have time."),
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
     mcq("Listening to a store announcement: 'Notre magasin est ouvert du lundi au samedi, de 9h à 20h, et le dimanche de 11h à 17h.' Sunday hours are:",["9h-20h","11h-17h","9h-17h","fermé le dimanche"],1,"Sunday (dimanche): 11h-17h. Extract the specific piece of information requested. Tip: when hearing hours, write them immediately: lun-sam: 9-20h, dim: 11-17h. Numbers disappear from memory fast — write as you hear!"),
     wr("Write the 3 key things to note when listening to a voicemail",["le nom de l'appelant","l'objet de l'appel","le numéro de rappel","la date et l'heure","l'urgence du message"],"1) Nom et organisation de l'appelant, 2) Raison de l'appel / message principal, 3) Numéro de rappel et délai. These 3 pieces of information let you respond appropriately to any voicemail. Write them down immediately before they fade from memory!")]),

  mkL("clb-03","CLB 4 Speaking: Describe Your Routine",20,"speaking",
    "CLB 4 speaking: describe your daily life clearly and coherently. You should be able to speak for 1-1.5 minutes on your daily routine without major hesitations. Use: present tense for habits, time markers (d'abord, puis, ensuite, le matin/soir), specific details (times, places, activities). CLB 4 allows: occasional errors that don't impede communication, simple vocabulary, short sentences. What matters: being understood, staying on topic, completing the task!",
    ["Parler 1-1.5 min sans pauses longues","Vocabulaire: routines quotidiennes","Marqueurs de temps: d'abord, puis, le matin...","CLB 4: quelques erreurs permises si compréhensible","Rester sur le sujet","Donner des détails précis (heures, lieux)","Éviter les longs silences (utiliser 'euh, donc...')","Auto-correction brève si erreur"],
    [mcq("At CLB 4 speaking, you are assessed primarily on:",["perfect grammar with zero errors","being understood and completing the communication task","using very advanced vocabulary","speaking with no accent"],1,"CLB 4 = communication first! Assessors ask: Can I understand this person? Did they complete the task? Occasional errors, simple vocabulary, and an accent are ALL acceptable at CLB 4. Focus on: clear message, staying on topic, appropriate length (1-1.5 min)!"),
     mcq("To fill a pause while thinking in French, you can say:",["nothing — silence is best","um um um... (English fillers)","euh... / donc... / c'est-à-dire... / voyons...","Excuse me please"],2,"Euh... (hesitation), Donc... (so...), C'est-à-dire... (that is to say...), Voyons... (let's see...). French fillers! Every fluent French speaker uses them. They show you're thinking in French, not just pausing. Much better than silence or English fillers in a CLB assessment!"),
     wr("Describe your typical morning in 3 sentences",["je me lève","le matin","d'abord","je prends","puis je","je pars"],"Le matin, je me lève à 6h30 et je prends une douche rapide. Ensuite, je mange mes céréales en écoutant les nouvelles. Puis, je prends le bus pour aller au travail — ça prend environ 25 minutes. — 3 sentences: clear routine, time markers, specific details = CLB 4 speaking success!")]),

  mkL("clb-04","CLB 4 Reading: Understand a Notice",20,"reading",
    "CLB 4 reading: understand short informational texts. Types: building notices, workplace announcements, school flyers, store signs, transit announcements. You need to: identify the main purpose, extract specific information (dates, times, locations, requirements), understand what action is needed. Strategy: read the title first (tells you the topic), then scan for key information asked in the question. Most CLB 4 reading texts are 100-200 words.",
    ["Textes CLB 4: 100-200 mots","Avis, annonces, flyers, panneaux","Identifier: le but (but = purpose) du texte","Extraire: dates, heures, lieux, exigences","Action requise: que doit-on faire?","Stratégie: titre → survol → réponse","Vocabulaire: avis, à compter du, prière de, veuillez","Longueur modérée, registre standard"],
    [mcq("Reading a building notice: 'Interruption d'eau chaude le jeudi 20 mars de 8h à 16h pour entretien.' What should residents expect?",["No water at all on March 20","No hot water from 8am to 4pm on Thursday March 20","No hot water for 20 days","The building will be closed"],1,"No hot water (pas d'eau chaude) from 8h to 16h (8am-4pm) on Thursday March 20. 'Entretien' = maintenance (reason given). Cold water is still available — only hot water is interrupted. Reading notices carefully = extract the SPECIFIC information (hot vs cold, hours, date)!"),
     mcq("'Prière de ne pas utiliser les ascenseurs ce jour-là.' This means:",["Please use the elevators that day","Please do not use the elevators that day","The elevators are broken permanently","Only residents can use the elevators"],1,"Prière de = please (formal notice language). 'Ne pas utiliser les ascenseurs' = do not use the elevators. 'Ce jour-là' = that day (not always/permanently). 'Prière de...' is a polite imperative found in formal notices — equivalent to 'Veuillez ne pas...'"),
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
    [mcq("In a CLB 5 service interaction, you might need to infer:",["every single word","what the caller needs to do next, even if not directly stated","only the names of speakers","only the topic"],0,"At CLB 5, you must sometimes INFER the next step from context. If a bank employee says 'Votre demande de carte a été approuvée — vous la recevrez dans 7 à 10 jours ouvrables', you can infer: no action needed, just wait. This inference skill is what separates CLB 4 from CLB 5!"),
     mcq("Hearing 'Vous devrez nous rappeler avec votre numéro de dossier', the key information is:",["the office phone number","you must call back with your file number","you should visit in person","the matter is resolved"],1,"Call back WITH your file number. 'Rappeler' = call back. 'Numéro de dossier' = file/case number. This is an action required. Two pieces of info: 1) action (call back), 2) what to have ready (file number). Always note both for CLB 5 listening!"),
     wr("What 3 questions should you ask after a service interaction to check comprehension?",["qu'est-ce que je dois faire?","quand est-ce que je dois le faire?","qu'est-ce que je dois apporter?","quel est le délai?","quel est le numéro de référence?"],"1) Qu'est-ce que je dois faire exactement? (What exactly do I need to do?) 2) Dans quel délai? (By when?) 3) Quels documents/informations dois-je avoir? (What do I need to have?) These 3 questions ensure you understood the action required — essential for CLB 5 service interactions!")]),

  mkL("clb-07","CLB 5 Speaking: Give an Opinion",25,"speaking",
    "CLB 5 speaking: express and justify your opinion on a familiar topic for 1.5-2 minutes. Structure: state your opinion → give reason 1 + example → give reason 2 + example → conclude. New at CLB 5: you should maintain your position if asked, use some complex sentences, and employ a range of connectors beyond 'parce que'. Topics: work, school, neighbourhood, environment, Canadian life, immigration experiences.",
    ["1.5-2 minutes d'opinion structurée","Énoncer la position clairement","Raison 1 + exemple concret","Raison 2 + exemple concret","Conclusion: donc, c'est pourquoi","Maintenir la position si challengé","Connecteurs: parce que, car, de plus, cependant","Quelques structures complexes","Vocabulaire varié (pas les mêmes mots répétés)"],
    [mcq("At CLB 5 speaking, which is most important?",["using only complex grammar","giving a perfect structure with sophisticated vocabulary","communicating your opinion clearly with justification","speaking for exactly 2 minutes"],2,"Communicating clearly WITH justification = CLB 5 core. Structure + reasoning = CLB 5 speaking. Perfect grammar? Not required. Exact timing? Close is fine. Clear, justified opinion? Essential! 'I think X because Y and Z' consistently delivered = CLB 5."),
     mcq("When an assessor challenges your opinion at CLB 5, you should:",["agree immediately with them","be unable to respond","defend your position politely with more evidence","change the topic"],2,"Defend politely! 'Je comprends votre point de vue, mais je maintiens que... En effet, [new evidence or example].' At CLB 5, you can defend your position. At CLB 6+, you're expected to nuance and engage in real back-and-forth. Giving up = CLB 3-4 behavior!"),
     wr("State your opinion on working from home in 2 sentences",["à mon avis, le télétravail","selon moi","je pense que travailler de la maison","le travail à distance"],"À mon avis, le télétravail offre une meilleure qualité de vie grâce à la flexibilité des horaires et à l'élimination des temps de transport. Cependant, il peut nuire aux relations avec les collègues et à la collaboration d'équipe. — 2 sentences: opinion + justification + nuance = CLB 5 speaking!")]),

  mkL("clb-08","CLB 5 Reading: Scan for Information",20,"reading",
    "CLB 5 reading: efficiently scan medium-length texts (200-400 words) to find specific information. Text types at CLB 5: job postings, news articles, service descriptions, schedules, informational brochures. New challenge: the texts are longer and contain more information — you must distinguish essential from non-essential. Strategy: question first → identify keyword → scan for keyword → read that section closely → answer.",
    ["Textes CLB 5: 200-400 mots","Types: offres d'emploi, articles, brochures, horaires","Distinguer l'essentiel du non-essentiel","Stratégie: question → mot-clé → scan → lire section → réponse","CLB 5: quelques questions d'inférence","Vocabulaire: professionnel, gouvernemental","Identifier le ton et le but du texte","Lire les titres et sous-titres en premier"],
    [mcq("In a job posting, to find the required education level, you scan for:",["the company name","the job title","words like 'formation', 'diplôme', 'études requises', 'DEC', 'BAC'","the application deadline"],2,"Scan for vocabulary clusters: 'Formation requise / Scolarité / Diplôme exigé / DEC en... / BAC en...' These signal the education section. Different companies format this differently — scanning for the vocabulary cluster is faster than reading everything!"),
     mcq("Reading a brochure: 'Ce service est offert gratuitement aux résidents de la région métropolitaine de Montréal.' Who qualifies?",["All Canadians","Only people born in Montreal","Residents of the Montreal metropolitan area","Visitors to Montreal"],2,"Résidents de la région métropolitaine de Montréal = residents of the greater Montreal area (not just the island). 'Gratuitement' = free of charge. CLB 5 reading = finding the specific qualifying condition (who, where, when it applies)!"),
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
     mcq("'Il tempère l'enthousiasme de son collègue' in a discussion means:",["He increases his colleague's enthusiasm","He moderates/dampens his colleague's enthusiasm","He agrees completely with his colleague","He ignores his colleague"],1,"Tempérer = to temper/moderate. He's pulling back his colleague's enthusiasm — a cautious or skeptical voice in the discussion. Inferring speakers' ATTITUDES (enthusiastic, skeptical, neutral, opposed) is a CLB 6 listening skill. Don't just hear the words — understand the stance!"),
     wr("After listening to a debate, write a 2-sentence summary of positions",["le premier interlocuteur pense","le deuxième estime","l'un affirme que","l'autre soutient que","ils sont en désaccord sur"],"Le premier interlocuteur affirme que l'immigration est bénéfique pour l'économie canadienne, en citant notamment les secteurs en pénurie de main-d'œuvre. Le second estime que l'intégration linguistique doit être prioritaire et que les ressources actuelles sont insuffisantes. — Positions clearly distinguished = CLB 6 listening comprehension!")]),

  mkL("clb-11","CLB 6 Speaking: Justify & Persuade",25,"speaking",
    "CLB 6 speaking: persuade and justify — go beyond opinion to actively convince! The difference from CLB 5: at CLB 5 you express and justify your opinion. At CLB 6, you anticipate objections, address counter-arguments, use rhetorical strategies (rhetorical questions, vivid examples, appeal to shared values). Language: 'Il est indéniable que...', 'N'est-il pas vrai que...?', 'Comme nous le savons tous...', 'Force est de reconnaître que...'",
    ["CLB 6 = persuader activement","Anticiper les objections","Réfuter les contre-arguments","Questions rhétoriques: 'N'est-il pas évident que...?'","Appel aux valeurs communes","Exemples concrets et frappants","'Il est indéniable que...'","'Comme en témoignent les faits...'","Conclure par un appel à l'action"],
    [mcq("A rhetorical question in persuasive speaking:",["requires an answer from the audience","is used to make a statement feel like an obvious conclusion","is a genuine request for information","signals the end of the argument"],1,"A rhetorical question doesn't require an answer — it's stated as if the answer is obvious, drawing the listener to agree. 'N'est-il pas évident que l'apprentissage du français enrichit votre vie au Canada?' implies: of course it does! Powerful persuasive device in French discourse."),
     mcq("'Il est indéniable que les immigrants contribuent à l'économie canadienne.' This phrase:",["expresses doubt","presents the claim as an undeniable fact","asks a question","refutes an argument"],1,"Il est indéniable que = it is undeniable that. Presents the following claim as if it's an established, uncontestable truth — a persuasive strategy. Use it for strong, well-supported points. Don't overuse it (you can't call everything 'undeniable'!)"),
     wr("Write a persuasive sentence addressing someone who thinks French is too hard to learn",["certes, le français peut paraître","cependant, des milliers d'immigrants","la preuve en est que","n'est-il pas vrai que","il est indéniable que"],"Certes, le français peut paraître complexe au premier abord. Cependant, des milliers d'immigrants réussissent à le maîtriser chaque année — la preuve en est que vous lisez ces mots en français en ce moment même! N'est-il pas encourageant de constater que vous progressez déjà? — Concession + evidence + rhetorical question = CLB 6 persuasion!")]),

  mkL("clb-12","CLB 6 Reading: Analyse a Text",25,"reading",
    "CLB 6 reading: go beyond comprehension to ANALYSIS. You must: identify the author's purpose (informer, persuader, critiquer, comparer), recognize stylistic choices (tone, examples, structure), evaluate the quality of arguments (well-supported? one-sided?), and detect implicit messages or assumptions. Text types: editorial, analytical essay, formal report, policy analysis. This is the level of reading required for professional and academic success in French Canada.",
    ["CLB 6 lecture = analyse, pas seulement compréhension","But de l'auteur: informer, persuader, critiquer","Ton: neutre, engagé, ironique, alarmiste","Qualité des arguments: bien étayés? partiaux?","Messages implicites et présupposés","Registre et vocabulaire révèlent le positionnement","Structure: thèse, développement, conclusion","À qui ce texte est-il destiné?"],
    [mcq("An analytical reading question 'What is the author's implicit assumption?' asks you to:",["find a direct quote from the text","identify something the author assumes without stating it","summarize the main point","count the paragraphs"],1,"Implicit assumption = something the author takes for granted without stating it. 'L'apprentissage du français est indispensable pour les immigrants' assumes that integration is a priority value. A critical reader asks: why assume this? For whom? This is CLB 6+ critical reading!"),
     mcq("An editorial (éditorial) is written to:",["only report facts objectively","provide information without opinion","present and defend the author's or publication's opinion on a topic","advertise products or services"],2,"Éditorial = opinion piece defending the publication's position. Different from a 'chronique' (regular opinion column) or 'article' (news reporting). In CLB 6 reading, identifying the text type helps you calibrate your critical approach: editorial? Expect bias. News report? Expect (some) objectivity."),
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
     mcq("'L'implicite' in listening refers to:",["words not spoken clearly","the tone of voice only","meaning that's conveyed without being directly stated","the ending of a conversation"],1,"L'implicite = implied meaning — what is understood without being stated. If a speaker says 'Malgré tous les efforts du gouvernement...' before describing failure, the implication is that the efforts were insufficient. CLB 7 = understanding these implied critiques, sarcasm, irony, and nuance!"),
     wr("Name 2 Radio-Canada programs you'll use for CLB 7 listening practice",["le téléjournal","les coulisses du pouvoir","tout le monde en parle","c'est encore mieux l'après-midi","les années lumière","ici première","rdi"],"Le Téléjournal (evening news — clear French, current affairs) + Tout le monde en parle (Sunday talk show — fast, informal, multiple speakers = challenging CLB 7 practice!). Les Coulisses du pouvoir (political analysis) is also excellent for academic/political vocabulary!")]),

  mkL("clb-15","CLB 7 Speaking: 3-Minute Monologue",30,"speaking",
    "CLB 7 speaking: a 3-minute sustained, organized monologue on a complex topic! At CLB 7, you are expected to: speak fluently without long pauses, use a range of complex structures (subjunctive, conditional perfect, nominalization), vary your vocabulary throughout (no repetition), demonstrate awareness of both sides of an issue, and draw a nuanced conclusion. This is professional-level French communication — the standard required for many Canadian workplaces and government positions.",
    ["3 minutes soutenues sans longues pauses","Structures complexes: subjonctif, cond. passé, nomi.","Vocabulaire varié tout au long (pas de répétition)","Conscience des deux côtés: concession forte","Conclusion nuancée (pas simpliste)","Rythme: modéré, articulé, assuré","Niveau professionnel et académique","CLB 7 = employabilité dans la plupart des secteurs"],
    [mcq("At CLB 7, the 3-minute monologue is distinguished by:",["the length alone","fluency, complexity, vocabulary range, and nuanced argumentation working together","using only simple sentences","having no errors at all"],1,"All elements working together = CLB 7. Fluency (no long pauses) + complexity (varied structures) + vocabulary range + nuance (sees both sides) + organized argument. It's not about perfection — it's about consistent B2-level production across 3 minutes!"),
     mcq("A 'nuanced conclusion' at CLB 7 means:",["saying 'in conclusion, I agree with myself'","acknowledging complexity and avoiding oversimplification while maintaining a clear position","having no conclusion","switching your position at the end"],1,"Nuanced = acknowledges complexity without abandoning your position. 'En conclusion, si l'immigration représente indéniablement des défis d'intégration, il demeure que ses bénéfices économiques et culturels l'emportent largement, à condition de mettre en place des politiques d'intégration adéquates.' = Nuanced, not simplistic!"),
     wr("Write the conclusion sentence of a CLB 7 monologue on Canadian identity",["en conclusion","il demeure que","bien que","malgré les défis","au final","force est de constater","la richesse de"],"En conclusion, bien que la définition de l'identité canadienne soit un sujet complexe et en constante évolution, force est de constater que sa richesse réside précisément dans cette diversité linguistique, culturelle et régionale qui la constitue. — Complex, nuanced, maintains a position without oversimplifying. CLB 7 conclusion!")]),

  mkL("clb-16","CLB 7 Reading: Critical Reading",25,"reading",
    "CLB 7 reading: analyze complex texts from multiple perspectives, evaluate the quality of evidence, identify rhetorical strategies, and form your own critical response. At this level you read: policy documents, academic articles, complex journalism, literature (in context). You can: distinguish between different types of evidence (anecdote vs data vs expert opinion), evaluate credibility, identify logical fallacies (generalization, false dichotomy), and appreciate stylistic choices.",
    ["CLB 7: analyse critique multi-perspectives","Types de preuves: anecdote, données, opinion experte","Évaluer la crédibilité des sources","Identifier les sophismes: généralisation, faux dilemme","Stratégies rhétoriques: pathos, logos, éthos","Style littéraire: ironie, hyperbole, euphémisme","Former sa propre réponse critique","CLB 7 lecture = niveau professionnel et académique"],
    [mcq("'Tous les immigrants veulent s'isoler de la société d'accueil' is an example of:",["a valid generalization","an anecdote","a logical fallacy (overgeneralization)","an expert opinion"],2,"Overgeneralization = logical fallacy. 'Tous les immigrants' with a single sweeping negative claim ignores enormous diversity of individual experiences and research. Critical readers at CLB 7 identify these fallacies and ask: 'How do you know? For all? Always? Is this supported by evidence?'"),
     mcq("An author who uses emotional stories to support their argument is using:",["logos (logic and reason)","éthos (credibility)","pathos (emotional appeal)","data and statistics"],2,"Pathos = emotional appeal. Stories about individual suffering or success make arguments more relatable and emotionally resonant. Not invalid — but should be distinguished from logos (logical arguments/data) and éthos (authority/credibility). CLB 7 readers can name which strategy is being used!"),
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
const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/7sY6oIaaYfe6c0K6Di2go00"; // ← paste your buy.stripe.com link here
const PRICE_DISPLAY = "$49/month";
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
  const handleUpgrade=()=>{
    // Send to web app for payment (Apple IAP compliant)
    window.open("https://franco.app?subscribe=1","_blank");
  };

  return <div style={{position:"fixed",inset:0,background:"rgba(13,27,62,0.75)",backdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:24,maxWidth:400,width:"100%",overflow:"hidden",boxShadow:"0 24px 80px rgba(13,27,62,0.3)",animation:"popIn 0.3s ease"}}>
      {/* Header */}
      <div style={{background:`linear-gradient(135deg,${T.navy} 0%,#1a3a7a 100%)`,padding:"28px 28px 20px",textAlign:"center",position:"relative"}}>
        <button onClick={onClose} style={{position:"absolute",top:14,right:14,background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:50,width:28,height:28,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        <div style={{fontSize:44,marginBottom:8}}>🔓</div>
        <div style={{fontFamily:"Georgia,serif",fontSize:22,fontWeight:900,color:"#fff",lineHeight:1.2}}>Unlock Franco Premium</div>
        <div style={{color:"rgba(255,255,255,0.75)",fontSize:13,marginTop:6}}>"{lessonTitle}" is a premium lesson</div>
      </div>

      {/* Price */}
      <div style={{padding:"20px 28px 0",textAlign:"center"}}>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:4}}>
          <span style={{fontFamily:"Georgia,serif",fontSize:42,fontWeight:900,color:T.navy}}>$49</span>
          <span style={{color:T.textMid,fontSize:16}}>/month</span>
        </div>
        <div style={{color:T.textSoft,fontSize:12,marginTop:2}}>Cancel anytime · Secure payment via Stripe</div>
      </div>

      {/* Features */}
      <div style={{padding:"16px 28px"}}>
        {[
          ["🎓","190 lessons","Foundation → B2/CLB 7"],
          ["🃏","8 practice games","Flashcard, Match, Speed & more"],
          ["🍁","Made for Canada","CLB + TEF exam prep included"],
          ["📈","Track progress","XP, streaks, lesson history"],
        ].map(([icon,title,sub])=>
          <div key={title} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 0",borderBottom:`1px solid ${T.border}`}}>
            <span style={{fontSize:22,width:32,textAlign:"center"}}>{icon}</span>
            <div>
              <div style={{fontWeight:700,fontSize:14,color:T.text}}>{title}</div>
              <div style={{fontSize:12,color:T.textSoft}}>{sub}</div>
            </div>
          </div>
        )}
      </div>

      {/* CTA */}
      <div style={{padding:"16px 28px 24px"}}>
        <button onClick={handleUpgrade} style={{width:"100%",padding:"16px",background:`linear-gradient(135deg,${T.blue},${T.navy})`,color:"#fff",border:"none",borderRadius:14,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:16,cursor:"pointer",boxShadow:`0 4px 20px ${T.blue}50`}}>
          🌐 Subscribe at franco.app
        </button>
        <div style={{textAlign:"center",marginTop:10}}>
          <span style={{fontSize:12,color:T.textSoft}}>3 free lessons included · No credit card for free tier</span>
        </div>
        <button onClick={onClose} style={{width:"100%",marginTop:8,padding:"10px",background:"transparent",border:"none",color:T.textSoft,fontSize:13,cursor:"pointer"}}>
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
        {["✅ Try Free","🍁 Made for Canada","190 Lessons","🎤 AI Coach","🔒 Premium Access"].map(tag=>
          <span key={tag} style={{fontSize:11,fontWeight:700,padding:"5px 12px",borderRadius:50,background:"rgba(16,185,129,0.25)",color:"#6EE7B7",border:"1px solid rgba(110,231,183,0.3)"}}>{tag}</span>
        )}
      </div>
      <div style={{display:"flex",gap:8}}>
        {steps.map((_,i)=><div key={i} onClick={()=>setStep(i)} style={{width:i===step?28:8,height:8,borderRadius:4,background:i===step?"#fff":"rgba(255,255,255,0.3)",cursor:"pointer",transition:"all 0.3s"}}/>)}
      </div>
      {step<steps.length-1
        ?<button onClick={()=>setStep(s=>s+1)} style={{background:"#fff",color:T.navy,border:"none",padding:"16px 40px",borderRadius:16,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:16,cursor:"pointer",boxShadow:"0 8px 32px rgba(0,0,0,0.2)"}}>Next →</button>
        :<button onClick={onNext} style={{background:"linear-gradient(135deg,#10B981,#059669)",color:"#fff",border:"none",padding:"16px 40px",borderRadius:16,fontFamily:"system-ui,-apple-system,sans-serif",fontWeight:700,fontSize:17,cursor:"pointer",boxShadow:"0 8px 32px rgba(16,185,129,0.4)"}}>Start Learning — Try Free! 🚀</button>}
      <div style={{fontSize:12,color:"rgba(255,255,255,0.45)"}}>No account required · 3 free lessons · Unlock all 190 with Premium</div>
    </div>
  </div>;
}

function OnboardingScreen({onComplete}){
  const[phase,setPhase]=useState("companion");
  const[companion,setCompanion]=useState(null);
  const[level,setLevel]=useState(null);
  const levels=[
    {id:"foundation",label:"Complete Beginner",hint:"I know almost no French",emoji:"🌱"},
    {id:"a1",label:"A1 — Basic",hint:"I know a few words and greetings",emoji:"🔤"},
    {id:"a2",label:"A2 — Elementary",hint:"I can handle simple conversations",emoji:"📖"},
    {id:"b1",label:"B1 — Intermediate",hint:"I can express opinions on familiar topics",emoji:"💬"},
    {id:"clb",label:"CLB Test Prep",hint:"I need focused Canadian benchmark prep",emoji:"🎓"},
  ];
  if(phase==="companion") return <div style={{minHeight:"100vh",background:T.surface,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,gap:32}}>
    <div style={{textAlign:"center"}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:T.textSoft,marginBottom:10}}>Step 1 of 2</div>
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
  return <div style={{minHeight:"100vh",background:T.surface,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,gap:32}}>
    <div style={{textAlign:"center"}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:T.textSoft,marginBottom:10}}>Step 2 of 2</div>
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
    <Btn onClick={()=>onComplete(companion,level)} disabled={!level} style={{padding:"15px 40px",fontSize:16}}>Start Learning →</Btn>
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
  const nextLesson=allL.find(l=>!progress[l.id]);
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
          <div style={{fontSize:10,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:.8,marginBottom:4}}>Your CLB Path</div>
          <div style={{fontSize:isMobile?14:16,fontWeight:800,color:"#0F172A",marginBottom:2}}>{level.label}</div>
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
  const[expanded,setExpanded]=useState(Object.keys(SYLLABUS)[0]);
  const[search,setSearch]=useState("");
  const isMobile=useIsMobile();
  const allLessons=Object.values(SYLLABUS).flatMap(lv=>lv.modules.flatMap(m=>m.lessons));
  const doneLessons=allLessons.filter(l=>progress[l.id]);
  const nextLesson=allLessons.find(l=>!progress[l.id]);
  const nextLevel=Object.values(SYLLABUS).find(lv=>lv.modules.flatMap(m=>m.lessons).some(l=>!progress[l.id]));
  const pct=Math.round((doneLessons.length/allLessons.length)*100);

  return <div style={{padding:isMobile?"10px":"20px 28px",maxWidth:760,margin:"0 auto"}}>

    {/* Compact header */}
    <div style={{background:"#0F172A",borderRadius:14,padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:12}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:2}}>{doneLessons.length}/{allLessons.length} lessons · {pct}% done</div>
        <div style={{fontSize:14,fontWeight:700,color:"#fff",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{nextLesson?`Next: ${nextLesson.title}`:"All lessons complete! 🎉"}</div>
      </div>
      {nextLesson&&nextLevel&&<button onClick={()=>onStartLesson(nextLesson,nextLevel)}
        style={{background:"#fff",color:"#0F172A",border:"none",padding:"8px 16px",borderRadius:9,fontFamily:"system-ui,sans-serif",fontWeight:700,fontSize:12,cursor:"pointer",flexShrink:0}}>
        Start →
      </button>}
    </div>

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

    {/* Level accordion — compact */}
    {Object.values(SYLLABUS).map(level=>{
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
              const locked=!isLessonFree(lesson.id)&&!isPremiumUnlocked();
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
    })}
  </div>;
}

// Vocab flip cards — extracted so hooks aren't called inside .map()
// ─── FRENCH TTS — uses browser Web Speech API ────────────────────────────────
function speakFrench(text){
  if(!('speechSynthesis' in window)) return;
  // Strip anything in parens (English translations) before speaking
  const cleaned = text.replace(/\(.*?\)/g,"").replace(/[()→]/g,"").trim();
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(cleaned);
  utt.lang = "fr-CA";
  utt.rate = 0.88;
  utt.pitch = 1;
  // Prefer a French voice if available
  const voices = window.speechSynthesis.getVoices();
  const frVoice = voices.find(v=>v.lang.startsWith("fr-CA"))
    || voices.find(v=>v.lang.startsWith("fr-FR"))
    || voices.find(v=>v.lang.startsWith("fr"));
  if(frVoice) utt.voice = frVoice;
  window.speechSynthesis.speak(utt);
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

function LessonScreen({lesson,level,companion,onComplete,onBack}){
  const c=companion||COMPANIONS[0];
  const isMobile=useIsMobile();

  // ── State ──
  const[phase,setPhase]=useState("recap"); // recap | teach | questions | review | done
  const[teachSlide,setTeachSlide]=useState(0);
  const[recapDone,setRecapDone]=useState(false);
  const[qIdx,setQIdx]=useState(0);
  const[selected,setSelected]=useState(null);
  const[answered,setAnswered]=useState(false);
  const[correct,setCorrect]=useState(0);
  const[xp,setXp]=useState(0);
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

  const questions = lesson.questions||[];
  const recapQs = lesson.recap ? 
    (lesson.recap.flatMap(lid => {
      const prev = [...(FOUNDATION_LESSONS||[]),...(A1_LESSONS||[]),...(A2_LESSONS||[]),...(B1_LESSONS||[])].find(l=>l.id===lid);
      return prev ? (prev.questions||[]).slice(0,2) : [];
    })).slice(0,3) : [];

  const total = questions.length;
  const currentQ = phase==="review" ? wrongQueue[reviewIdx] : questions[qIdx];
  const q = currentQ;
  const isOk = q && (() => {
    if(!q) return false;
    if(q.type==="match") return matchDone.length === (q.pairs||[]).length && matchWrong.length===0;
    if(q.type==="tap"||q.type==="mcq"||q.type==="scene") return selected===q.correct;
    if(q.type==="fill") return selected===q.correct;
    if(q.type==="order") return JSON.stringify(orderPlaced)===JSON.stringify(q.answer);
    return true;
  })();

  const speak=(text)=>{
    if(!text) return;
    window.speechSynthesis?.cancel();
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
      speak(c.messages?.correct||"Excellent!");
    } else {
      speak(c.messages?.wrong||"Good try!");
      // Add to wrong queue for review at end (with different type)
      setWrongQueue(prev=>[...prev, {...q, _review:true}]);
    }
  };

  const nextQ=()=>{
    window.speechSynthesis?.cancel();
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

  const diffColor=(d)=>d<=1?"#10B981":d<=2?"#3B82F6":d<=3?"#F59E0B":d<=4?"#EF4444":"#8B5CF6";
  const diffLabel=(d)=>d<=1?"Easy ⭐":d<=2?"Medium ⭐⭐":d<=3?"Hard ⭐⭐⭐":d<=4?"Very Hard":"Expert";

  // ── Recap Phase ──
  if(phase==="recap"){
    if(recapQs.length===0||recapDone){
      setPhase("teach"); setRecapDone(true);
      return null;
    }
    return <div style={{minHeight:"calc(100vh - 52px)",background:"#F8FAFC"}}>
      <div style={{background:"#fff",borderBottom:"1px solid #E2E8F0",position:"sticky",top:52,zIndex:50}}>
        <div style={{padding:"0 16px",height:46,display:"flex",alignItems:"center",gap:10}}>
          <button onClick={()=>{window.speechSynthesis?.cancel();onBack();}} style={{background:"none",border:"none",padding:"4px",fontSize:13,fontWeight:600,cursor:"pointer",color:"#64748B"}}>← Back</button>
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

  return <div style={{minHeight:"calc(100vh - 52px)",background:"#F8FAFC"}}>
    {/* TOP BAR */}
    <div style={{background:"#fff",borderBottom:"1px solid #E2E8F0",position:"sticky",top:52,zIndex:50}}>
      <div style={{padding:"0 16px",height:46,display:"flex",alignItems:"center",gap:10}}>
        <button onClick={()=>{if(window.confirm("Leave lesson?")){window.speechSynthesis?.cancel();onBack();}}}
          style={{background:"none",border:"none",padding:"4px",fontSize:13,fontWeight:600,cursor:"pointer",color:"#64748B",flexShrink:0}}>← Back</button>
        <div style={{flex:1,fontSize:12,fontWeight:700,color:"#0F172A",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{lesson.title}</div>
        <div style={{fontSize:11,fontWeight:600,color:"#94A3B8",flexShrink:0}}>
          {phase==="teach"?"Lesson":phase==="done"?"Done!":phase==="review"?"Review 🔄":`${qIdx+1}/${total}`}
        </div>
      </div>
      <div style={{height:2,background:"#F1F5F9"}}>
        <div style={{height:"100%",
          width:phase==="teach"?"8%":phase==="done"?"100%":phase==="review"?"95%":`${Math.round(((qIdx+(answered?1:0))/total)*100)}%`,
          background:phase==="review"?"#F59E0B":"#0F172A",transition:"width 0.4s"}}/>
      </div>
    </div>

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
              <div style={{padding:"16px 18px"}}>
                <div style={{fontSize:10,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:.8,marginBottom:10}}>The story</div>
                <div style={{fontSize:14,color:"#334155",lineHeight:1.85,marginBottom:14}}>{lesson.teach}</div>
                <button onClick={()=>speakEnglish(lesson.teach)} style={{display:"flex",alignItems:"center",gap:6,background:"#F8FAFC",border:"1px solid #E2E8F0",borderRadius:50,padding:"6px 14px",fontSize:12,color:"#64748B",cursor:"pointer",fontWeight:600}}>🔈 Listen</button>
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

        {/* Question type label */}
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:10,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:.5}}>
            {q.type==="tap"?"👆 Tap the answer":q.type==="mcq"?"🎯 Choose the best answer":q.type==="fill"?"✏️ Fill in the blank":q.type==="order"?"🔀 Build the sentence":q.type==="match"?"🔗 Match the pairs":q.type==="scene"?"📖 Read & answer":q.type==="speak"?"🎤 Speaking":"✍️ Write"}
          </span>
          <div style={{flex:1,height:1,background:"#F1F5F9"}}/>
          <span style={{fontSize:10,fontWeight:700,color:diffColor(q.diff||2)}}>{diffLabel(q.diff||2)}</span>
        </div>

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
                return <button key={i} disabled={isDone} onClick={()=>handleMatch("fr",i)}
                  style={{padding:"10px 12px",borderRadius:10,border:`2px solid ${isDone?"#10B981":isWrong?"#EF4444":isSel?"#2563EB":"#E2E8F0"}`,background:isDone?"#ECFDF5":isWrong?"#FEF2F2":isSel?"#EFF6FF":"#F8FAFC",fontSize:13,fontWeight:600,color:isDone?"#059669":isWrong?"#DC2626":isSel?"#2563EB":"#0F172A",cursor:isDone?"default":"pointer",textAlign:"left",transition:"all 0.2s",textDecoration:isDone?"line-through":"none"}}>
                  {pair[0]}
                </button>;
              })}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              <div style={{fontSize:10,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:.5,marginBottom:2}}>English</div>
              {(q.pairs||[]).map((pair,i)=>{
                const isDone=matchDone.includes(pair[0]);
                const isSel=matchSel?.side==="en"&&matchSel?.idx===i;
                return <button key={i} disabled={isDone} onClick={()=>handleMatch("en",i)}
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
            <div style={{fontSize:11,color:"#94A3B8",marginBottom:8}}>Write in French — Claude will check it</div>
            {!answered?<AIWritingChecker prompt={q.prompt} accepted={q.accepted} level={level?.cefrTag||"A1"}
              onResult={(ok)=>{if(!answered){setAnswered(true);if(ok){setCorrect(x=>x+1);setXp(x=>x+(q.diff||1)*10);}speak(ok?"Excellent!":"Good try!");}}}/>
            :<div style={{padding:"10px 14px",borderRadius:10,background:isOk?"#ECFDF5":"#FEF2F2",fontSize:13,color:isOk?"#059669":"#DC2626",fontWeight:600}}>{isOk?"✓ Great answer!":"✗ Submitted"}</div>}
          </div>
        </div>}

        {/* SPEAK */}
        {q.type==="speak"&&<div style={{background:"#fff",borderRadius:16,border:"1px solid #E2E8F0",overflow:"hidden"}}>
          <div style={{padding:"18px",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{fontSize:15,fontWeight:700,color:"#0F172A",lineHeight:1.55}}>{q.prompt}</div>
          </div>
          <div style={{padding:"14px 18px"}}>
            <AISpeakingCoach prompt={q.prompt} sampleAnswer={q.sampleAnswer||q.accepted?.[0]||""}
              onDone={(passed)=>{if(!answered){setAnswered(true);if(passed){setCorrect(x=>x+1);setXp(x=>x+(q.diff||1)*10);}speak(passed?"Excellent!":"Good try!");}}}/>
          </div>
        </div>}

        {/* FEEDBACK */}
        {answered&&q.type!=="match"&&<div style={{borderRadius:14,border:`1px solid ${isOk?"#6EE7B7":"#FCA5A5"}`,background:isOk?"#F0FDF4":"#FFF5F5",padding:"14px 16px",display:"flex",gap:12}}>
          <span style={{fontSize:20,flexShrink:0}}>{isOk?"✅":"💡"}</span>
          <div>
            <div style={{fontWeight:700,fontSize:13,color:isOk?"#059669":"#DC2626",marginBottom:4}}>
              {isOk?"Correct! 🌟":"Good try — here's why:"}
            </div>
            <div style={{fontSize:13,color:isOk?"#065F46":"#7F1D1D",lineHeight:1.65}}>{q.explain}</div>
            {!isOk&&phase!=="review"&&<div style={{marginTop:6,fontSize:11,color:"#94A3B8"}}>🔄 This will come back at the end in a different format</div>}
          </div>
        </div>}

        {/* ACTIONS */}
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {q.type==="match"?
            <button onClick={()=>nextQ()} disabled={matchDone.length!==(q.pairs||[]).length}
              style={{flex:1,padding:"13px",background:matchDone.length===(q.pairs||[]).length?"#0F172A":"#F1F5F9",color:matchDone.length===(q.pairs||[]).length?"#fff":"#94A3B8",border:"none",borderRadius:12,fontFamily:"system-ui",fontWeight:700,fontSize:14,cursor:"pointer"}}>
              {qIdx<total-1?"Next →":"See Results →"}
            </button>
          :!answered?
            <button onClick={checkAnswer}
              disabled={(q.type==="tap"||q.type==="mcq"||q.type==="fill"||q.type==="scene")?selected===null:q.type==="order"?orderPlaced.length===0:false}
              style={{flex:1,padding:"13px",background:((q.type==="tap"||q.type==="mcq"||q.type==="fill"||q.type==="scene")&&selected===null)||(q.type==="order"&&orderPlaced.length===0)?"#F1F5F9":"#0F172A",color:((q.type==="tap"||q.type==="mcq"||q.type==="fill"||q.type==="scene")&&selected===null)||(q.type==="order"&&orderPlaced.length===0)?"#94A3B8":"#fff",border:"none",borderRadius:12,fontFamily:"system-ui",fontWeight:700,fontSize:14,cursor:"pointer",transition:"all 0.2s"}}>
              Check Answer
            </button>
          :
            <button onClick={nextQ}
              style={{flex:1,padding:"13px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontFamily:"system-ui",fontWeight:700,fontSize:14,cursor:"pointer"}}>
              {phase==="review"?reviewIdx<wrongQueue.length-1?"Next Review →":"See Results →":qIdx<total-1?"Next Question →":"See Results →"}
            </button>
          }
          {!answered&&q.type!=="speak"&&q.type!=="write"&&q.type!=="match"&&
            <button onClick={()=>nextQ()} style={{padding:"13px 16px",background:"#F8FAFC",color:"#94A3B8",border:"1px solid #E2E8F0",borderRadius:12,fontFamily:"system-ui",fontWeight:600,fontSize:13,cursor:"pointer"}}>Skip</button>}
          {!answered&&q.type!=="match"&&<AIHintButton question={q} level={level?.cefrTag||"A1"}/>}
        </div>
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
        <div style={{display:"flex",gap:10,width:"100%"}}>
          <button onClick={onComplete} style={{flex:1,padding:"14px",background:"#0F172A",color:"#fff",border:"none",borderRadius:12,fontFamily:"system-ui",fontWeight:800,fontSize:14,cursor:"pointer"}}>✓ Complete & Continue</button>
          <button onClick={()=>{setPhase("teach");setTeachSlide(0);setQIdx(0);setCorrect(0);setXp(0);setWrongQueue([]);resetQ();}} style={{padding:"14px 18px",background:"#F8FAFC",color:"#64748B",border:"1px solid #E2E8F0",borderRadius:12,fontFamily:"system-ui",fontWeight:600,fontSize:13,cursor:"pointer"}}>↺ Try again</button>
        </div>
      </div>}

    </div>
  </div>;
}

function AISpeakingCoach({prompt, sampleAnswer, onDone}){
  const[stage,setStage]=useState("ready"); // ready | recording | processing | feedback
  const[transcript,setTranscript]=useState("");
  const[feedback,setFeedback]=useState(null);
  const[mediaRec,setMediaRec]=useState(null);
  const recognitionRef=useRef(null);

  const startRecording=()=>{
    if(!("webkitSpeechRecognition" in window||"SpeechRecognition" in window)){
      alert("Speech recognition not supported in this browser. Please use Chrome.");
      return;
    }
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    const rec=new SR();
    rec.lang="fr-CA";
    rec.interimResults=true;
    rec.maxAlternatives=1;
    recognitionRef.current=rec;
    let finalText="";
    rec.onresult=(e)=>{
      finalText=Array.from(e.results).map(r=>r[0].transcript).join(" ");
      setTranscript(finalText);
    };
    rec.onend=()=>{
      setStage("processing");
      analyzeWithAI(finalText);
    };
    rec.start();
    setStage("recording");
    // Auto-stop after 15s
    setTimeout(()=>{try{rec.stop();}catch{}},15000);
  };

  const stopRecording=()=>{
    try{recognitionRef.current?.stop();}catch{}
  };

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
        <div style={{fontFamily:"Georgia,serif",fontSize:17,fontWeight:700,color:T.navy}}>AI Speaking Coach</div>
        <div style={{fontSize:12,color:T.textSoft}}>Powered by Claude AI — speaks French Canadian 🍁</div>
      </div>
    </div>

    <div style={{background:"rgba(255,255,255,0.7)",borderRadius:12,padding:14,marginBottom:14}}>
      <div style={{fontSize:12,fontWeight:700,color:T.textSoft,textTransform:"uppercase",letterSpacing:.8,marginBottom:6}}>💬 Say this:</div>
      <div style={{fontSize:15,fontWeight:600,color:T.navy,lineHeight:1.6,display:"flex",alignItems:"flex-start",gap:8}}>
        <span style={{flex:1}}>{sampleAnswer}</span>
        <SpeakBtn text={sampleAnswer} size={18}/>
      </div>
    </div>

    {stage==="ready"&&<>
      {transcript&&<div style={{background:"#fff",borderRadius:10,padding:12,marginBottom:12,fontSize:13,color:T.textMid,fontStyle:"italic"}}>Last attempt: "{transcript}"</div>}
      <button onClick={startRecording} style={{background:"#F97316",color:"#fff",border:"none",padding:"14px 28px",borderRadius:14,fontWeight:700,fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",gap:8,fontFamily:"system-ui,-apple-system,sans-serif"}}>
        🎤 Start Speaking
      </button>
      <div style={{fontSize:12,color:T.textSoft,marginTop:8}}>Uses your microphone · French Canadian dialect</div>
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
      <div style={{marginTop:8,fontWeight:700,color:T.navy}}>AI is analyzing your French...</div>
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
        <button onClick={()=>onDone(feedback.score>=60)} style={{background:T.mint,color:"#fff",border:"none",padding:"10px 20px",borderRadius:10,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"system-ui,-apple-system,sans-serif"}}>Continue →</button>
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
    const sys=`You are a warm French language teacher for Canadian learners at ${level} level.
Check the student's French writing and respond in JSON:
{
  "correct": true,
  "score": 90,
  "corrected": "The corrected version of their answer",
  "explanation": "Brief explanation of what they did right/wrong",
  "grammar_note": "One specific grammar tip if needed",
  "encouragement": "Short encouraging message"
}
Be kind. If mostly correct, mark correct:true. Accept natural variations.`;
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
      // Fallback to simple check
      const v=val.trim().toLowerCase();
      const ok=accepted.some(a=>v.includes(a.toLowerCase()));
      setResult({correct:ok,score:ok?85:40,corrected:accepted[0],explanation:ok?"Great answer!":"Check the accepted answer below.",encouragement:ok?"Excellent! 🌟":"Keep practicing! 💪"});
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
      <div style={{fontSize:13,color:result.correct?"#065F46":"#78350F",lineHeight:1.6}}>{result.explanation}</div>
      {result.grammar_note&&<div style={{marginTop:8,fontSize:12,color:"#5B21B6",fontWeight:600,background:"#EDE9FE",borderRadius:8,padding:"6px 10px"}}>📚 {result.grammar_note}</div>}
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
    setHint(h);setLoading(false);
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
- Use relevant emojis
- Always end with a question or prompt to keep conversation going`;
    const opening=await callClaude(sys,`Start our ${t.label} conversation! Greet me warmly in French and ask me an easy opening question.`,200);
    setMsgs([{role:"assistant",text:opening}]);
    setLoading(false);
  };

  const sendMessage=async()=>{
    if(!input.trim()||loading) return;
    const userMsg={role:"user",text:input};
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
- Mix French with English explanations
- Use emojis`;
    const history=newMsgs.slice(-6).map(m=>`${m.role==="user"?"Student":"Teacher"}: ${m.text}`).join("\n");
    const reply=await callClaude(sys,`Conversation so far:\n${history}\n\nContinue naturally. Keep it short and ask a follow-up question.`,200);
    setMsgs(m=>[...m,{role:"assistant",text:reply}]);
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
      <div style={{fontFamily:"Georgia,serif",fontSize:26,fontWeight:900,color:T.navy,marginBottom:6}}>💬 AI Conversation Partner</div>
      <div style={{fontSize:15,color:T.textMid,marginBottom:28}}>Practice real French conversation with your AI tutor — powered by Claude. Pick a topic to start!</div>
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
          <div style={{fontSize:11,color:T.mint,fontWeight:600}}>AI Conversation Partner · Claude-powered 🤖</div>
        </div>
        <div style={{marginLeft:"auto",fontSize:12,color:T.textSoft}}>{msgs.length} exchanges</div>
      </div>

      {/* Messages */}
      <div style={{flex:1,overflowY:"auto",padding:"20px 20px 0"}}>
        {msgs.map((m,i)=><div key={i} style={{display:"flex",gap:10,marginBottom:16,flexDirection:m.role==="user"?"row-reverse":"row"}}>
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
function PersonalTutorScreen({companion, progress, startLevel, onNavigate}){
  const c = companion||COMPANIONS[0];
  const level = SYLLABUS[startLevel]||SYLLABUS.foundation;
  const allL = Object.values(SYLLABUS).flatMap(l=>l.modules.flatMap(m=>m.lessons));
  const done = allL.filter(l=>progress[l.id]);
  const notDone = allL.filter(l=>!progress[l.id]);
  const [msgs,setMsgs] = useState([]);
  const [input,setInput] = useState("");
  const [loading,setLoading] = useState(false);
  const [mode,setMode] = useState("chat"); // chat | conversation | writing | grammar
  const [writingText,setWritingText] = useState("");
  const [showModes,setShowModes] = useState(false);
  const bottomRef = useRef();
  const authCtx = useAuth();

  const MODES = [
    {id:"chat", icon:"💬", label:"Ask Anything", desc:"Questions, tips, explanations"},
    {id:"conversation", icon:"🗣️", label:"Conversation Practice", desc:"Speak French with your tutor"},
    {id:"writing", icon:"✍️", label:"Writing Coach", desc:"Submit French text for feedback"},
    {id:"grammar", icon:"📚", label:"Grammar Drill", desc:"Practice specific grammar rules"},
  ];

  const systemPrompt = `You are Sophie, an expert French tutor specializing in helping immigrants succeed in Canada. You are warm, patient, encouraging, and deeply knowledgeable about Quebec French, CLB exams, and TEF Canada.

LEARNER PROFILE:
- Level: ${level.label} (${level.cefrTag})
- Lessons completed: ${done.length}/${allL.length}
- Recent lessons: ${done.slice(-5).map(l=>l.title).join(", ")||"None yet"}
- Next lesson: ${notDone[0]?.title||"All complete!"}

YOUR TEACHING STYLE:
- Always correct French mistakes gently but clearly, showing the correct form
- Use emojis sparingly to make learning fun
- Give concrete Canadian examples (Montreal, Quebec, RAMQ, etc.)
- Mix English and French at the learner's level
- Be specific — never give vague advice
- Reference their actual progress when relevant
- For CONVERSATION mode: respond mostly in French, gently correct errors, keep conversation natural
- For WRITING mode: give detailed line-by-line feedback with corrections
- For GRAMMAR mode: explain rules clearly with multiple examples
- Keep responses concise (3-5 sentences) unless explaining something complex
- End with a small challenge or question to keep engagement

CURRENT MODE: ${mode === "chat" ? "General tutoring — answer questions and give advice" : mode === "conversation" ? "CONVERSATION PRACTICE — respond in French, correct errors naturally, keep it conversational and fun" : mode === "writing" ? "WRITING COACH — analyze the submitted French text carefully, correct every error, explain each correction" : "GRAMMAR DRILL — focus on grammar rules, give examples, quiz the learner"}

Remember: These learners NEED French for their lives in Canada — for jobs, citizenship, healthcare. Your teaching matters deeply.`;

  const sendMessage = async(text, isWritingSubmit=false) => {
    if(!text.trim()||loading) return;
    const displayText = isWritingSubmit ? `Please review my French writing:

"${text}"` : text;
    const userMsg = {role:"user", text:displayText};
    const newMsgs = [...msgs, userMsg];
    setMsgs(newMsgs);
    setInput("");
    if(isWritingSubmit) setWritingText("");
    setLoading(true);
    try{
      const history = newMsgs.slice(-10).map(m=>`${m.role==="user"?"Learner":"Sophie"}: ${m.text}`).join("\n");
      const reply = await callClaude(systemPrompt, history+"\nSophie:", 600);
      setMsgs(m=>[...m,{role:"assistant",text:reply}]);
    }catch(e){
      setMsgs(m=>[...m,{role:"assistant",text:"Sorry, I had a connection issue. Please try again!"}]);
    }
    setLoading(false);
    setTimeout(()=>bottomRef.current?.scrollIntoView({behavior:"smooth"}),100);
  };

  const QUICK_PROMPTS = {
    chat: [
      "What should I study today?",
      "Explain passé composé vs imparfait",
      "How do I prepare for CLB speaking?",
      "Give me tips for Quebec French",
      "Quiz me on vocabulary",
    ],
    conversation: [
      "Parlons de ta journée! (Let\'s talk about your day)",
      "Practice: job interview in French",
      "Talk about your life in Canada",
      "Order food at a Quebec restaurant",
      "Discuss the weather like a Quebecer",
    ],
    writing: [],
    grammar: [
      "Drill me on être vs avoir",
      "Practice subjunctive triggers",
      "Test me on gender of nouns",
      "Quiz: adjective agreement",
      "Practice negation ne...pas",
    ],
  };

  useEffect(()=>{
    if(msgs.length > 0) return;
    const greet = async()=>{
      setLoading(true);
      const prompt = done.length===0
        ? "Greet this new learner warmly. Introduce yourself as Sophie, their personal French tutor. Tell them you\'re excited to help them learn French for Canada. Ask what brings them to learn French and what their goals are. Be warm and welcoming. Keep it to 3 sentences."
        : `Greet this returning learner. They\'ve completed ${done.length} lessons. Welcome them back, mention one specific thing about their recent progress (last lesson: ${done[done.length-1]?.title||"getting started"}), and ask what they want to work on today. Be encouraging. 3 sentences.`;
      const reply = await callClaude(systemPrompt, prompt, 200);
      setMsgs([{role:"assistant", text:reply}]);
      setLoading(false);
    };
    greet();
  },[]);

  useEffect(()=>{
    if(msgs.length===0) return;
    // Re-greet when mode changes
    const modeGreets = {
      conversation: "Bonjour! 🗣️ Let\'s practice speaking French together. I\'ll respond mostly in French and gently correct any mistakes. What would you like to talk about? / Qu\'est-ce que tu voudrais discuter?",
      writing: "Welcome to Writing Coach! ✍️ Type or paste any French text below and I\'ll give you detailed feedback — correcting errors, explaining grammar, and helping you write like a native. Ready when you are!",
      grammar: "Grammar Drill mode activated! 📚 Tell me which grammar point you want to practice, or choose a quick prompt below and I\'ll create targeted exercises just for you.",
      chat: "Back to general tutoring mode! 💬 What would you like to know or practice?",
    };
    setMsgs(m=>[...m,{role:"assistant",text:modeGreets[mode]}]);
  },[mode]);

  const modeColor = {chat:"#2563EB",conversation:"#059669",writing:"#7C3AED",grammar:"#DC2626"};
  const currentColor = modeColor[mode];

  return <div style={{display:"flex",flexDirection:"column",height:"100%",background:T.bg,maxWidth:680,margin:"0 auto",width:"100%"}}>

    {/* Header */}
    <div style={{background:`linear-gradient(135deg,${T.navy},#1a3a7a)`,padding:"16px 20px",color:"#fff"}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
        <div style={{fontSize:36}}>{c.avatar}</div>
        <div>
          <div style={{fontFamily:"Georgia,serif",fontSize:18,fontWeight:800}}>Sophie</div>
          <div style={{fontSize:12,opacity:0.8}}>Your Personal French Tutor · {level.label}</div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:8}}>
          <div style={{background:"rgba(255,255,255,0.15)",borderRadius:20,padding:"4px 10px",fontSize:11,fontWeight:600}}>
            {done.length}/{allL.length} lessons
          </div>
        </div>
      </div>

      {/* Mode selector */}
      <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:2}}>
        {MODES.map(m=>(
          <button key={m.id} onClick={()=>setMode(m.id)} style={{
            display:"flex",alignItems:"center",gap:5,padding:"6px 12px",
            background:mode===m.id?"rgba(255,255,255,0.25)":"rgba(255,255,255,0.1)",
            border:mode===m.id?"2px solid rgba(255,255,255,0.6)":"2px solid transparent",
            borderRadius:20,color:"#fff",fontSize:12,fontWeight:mode===m.id?700:500,
            cursor:"pointer",whiteSpace:"nowrap",flexShrink:0,
          }}>
            <span>{m.icon}</span>
            <span>{m.label}</span>
          </button>
        ))}
      </div>
    </div>

    {/* Messages */}
    <div style={{flex:1,overflowY:"auto",padding:"16px 20px",display:"flex",flexDirection:"column",gap:12}}>
      {msgs.map((msg,i)=>(
        <div key={i} style={{display:"flex",flexDirection:msg.role==="user"?"row-reverse":"row",gap:10,alignItems:"flex-start"}}>
          {msg.role==="assistant"&&<div style={{fontSize:28,flexShrink:0,marginTop:2}}>{c.avatar}</div>}
          <div style={{
            maxWidth:"78%",padding:"12px 16px",borderRadius:msg.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px",
            background:msg.role==="user"?`linear-gradient(135deg,${currentColor},${T.navy})`:"#fff",
            color:msg.role==="user"?"#fff":T.text,
            boxShadow:"0 2px 8px rgba(0,0,0,0.08)",
            fontSize:14,lineHeight:1.6,whiteSpace:"pre-wrap",
          }}>
            {msg.text}
          </div>
        </div>
      ))}
      {loading&&<div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
        <div style={{fontSize:28}}>{c.avatar}</div>
        <div style={{background:"#fff",padding:"12px 16px",borderRadius:"18px 18px 18px 4px",boxShadow:"0 2px 8px rgba(0,0,0,0.08)"}}>
          <div style={{display:"flex",gap:4}}>
            {[0,1,2].map(i=><div key={i} style={{width:8,height:8,borderRadius:"50%",background:currentColor,animation:`bounce 1.2s ease-in-out ${i*0.2}s infinite`}}/>)}
          </div>
        </div>
      </div>}
      <div ref={bottomRef}/>
    </div>

    {/* Quick prompts */}
    {QUICK_PROMPTS[mode].length>0&&msgs.length<=2&&<div style={{padding:"0 20px 8px",display:"flex",gap:6,overflowX:"auto"}}>
      {QUICK_PROMPTS[mode].map(p=>(
        <button key={p} onClick={()=>sendMessage(p)} style={{
          padding:"6px 12px",background:"#fff",border:`1.5px solid ${currentColor}`,
          borderRadius:20,color:currentColor,fontSize:12,fontWeight:600,
          cursor:"pointer",whiteSpace:"nowrap",flexShrink:0,
        }}>{p}</button>
      ))}
    </div>}

    {/* Writing mode input */}
    {mode==="writing"
      ? <div style={{padding:"12px 20px 20px",background:"#fff",borderTop:`1px solid ${T.border}`}}>
          <textarea
            value={writingText}
            onChange={e=>setWritingText(e.target.value)}
            placeholder="Type or paste your French text here for detailed feedback..."
            style={{width:"100%",height:100,padding:"10px 14px",border:`1.5px solid ${T.border}`,borderRadius:12,fontSize:14,fontFamily:"Georgia,serif",resize:"none",outline:"none",boxSizing:"border-box"}}
          />
          <button
            onClick={()=>writingText.trim()&&sendMessage(writingText,true)}
            disabled={!writingText.trim()||loading}
            style={{width:"100%",marginTop:8,padding:"12px",background:writingText.trim()?`linear-gradient(135deg,${currentColor},#5B21B6)`:"#E2E8F0",color:writingText.trim()?"#fff":"#94A3B8",border:"none",borderRadius:12,fontWeight:700,fontSize:15,cursor:writingText.trim()?"pointer":"default"}}
          >
            ✍️ Get Feedback
          </button>
        </div>
      : <div style={{padding:"12px 20px 20px",background:"#fff",borderTop:`1px solid ${T.border}`,display:"flex",gap:8}}>
          <input
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendMessage(input)}
            placeholder={mode==="conversation"?"Écris en français... (Write in French...)":"Ask Sophie anything..."}
            style={{flex:1,padding:"12px 16px",border:`1.5px solid ${T.border}`,borderRadius:24,fontSize:14,outline:"none",fontFamily:"system-ui,-apple-system,sans-serif"}}
          />
          <button
            onClick={()=>sendMessage(input)}
            disabled={!input.trim()||loading}
            style={{padding:"12px 18px",background:input.trim()?`linear-gradient(135deg,${currentColor},${T.navy})`:"#E2E8F0",color:input.trim()?"#fff":"#94A3B8",border:"none",borderRadius:24,fontWeight:700,fontSize:14,cursor:input.trim()?"pointer":"default"}}
          >
            {loading?"...":"Send →"}
          </button>
        </div>
    }
  </div>;
}


function ProfileScreen({companion,progress,startLevel,onReset,user,guestMode,onAuthNav}){
  const[adminTaps,setAdminTaps]=useState(0);
  const[showAdmin,setShowAdmin]=useState(false);
  const[adminEmail,setAdminEmail]=useState("");
  const[adminDays,setAdminDays]=useState("31");
  const[adminMsg,setAdminMsg]=useState("");
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
  const{logout}=useAuth();
  const c=companion||COMPANIONS[0];
  const level=SYLLABUS[startLevel]||SYLLABUS.foundation;
  const allL=Object.values(SYLLABUS).flatMap(l=>l.modules.flatMap(m=>m.lessons));
  const done=allL.filter(l=>progress[l.id]);
  const xp=done.length*25;
  const isPremium=isPremiumUnlocked();
  const handleLogout=async()=>{ await logout(); window.location.reload(); };
  const [showDeleteConfirm,setShowDeleteConfirm]=useState(false);
  const [deleteLoading,setDeleteLoading]=useState(false);
  const handleDeleteAccount=async()=>{
    if(!showDeleteConfirm){setShowDeleteConfirm(true);return;}
    setDeleteLoading(true);
    try{
      const auth=getAuth();
      const u=auth.currentUser;
      if(u){
        const db=getFirestore();
        try{await deleteDoc(doc(db,"users",u.uid));}catch{}
        try{await deleteDoc(doc(db,"premiumUsers",u.uid));}catch{}
        await u.delete();
      }
      window.location.reload();
    }catch(e){
      if(e.code==="auth/requires-recent-login"){
        alert("For security, please sign out and sign back in before deleting your account.");
      }else{
        alert("Error deleting account: "+e.message);
      }
      setDeleteLoading(false);
      setShowDeleteConfirm(false);
    }
  };
  const displayName=user?.displayName||user?.email?.split("@")[0]||null;

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

      <div style={{marginBottom:12}}>
        <div style={{fontSize:12,color:T.textSoft,marginBottom:2}}>Email verification</div>
        <div style={{fontSize:14,fontWeight:600,color:T.navy}}>{guestMode?"Not available":user?.emailVerified?"Verified ✓":"Pending"}</div>
      </div>

      <div style={{marginBottom:4}}>
        <div style={{fontSize:12,color:T.textSoft,marginBottom:6}}>Subscription</div>
        <span style={{fontSize:12,fontWeight:600,padding:"4px 12px",borderRadius:50,background:isPremium?"#D1FAE5":"#F1F5F9",color:isPremium?"#065F46":T.textMid,border:`1px solid ${isPremium?"#6EE7B7":T.border}`}}>
          {isPremium?"Premium ✓":"Free Plan"}
        </span>
      </div>
    </div>

    {/* More section */}
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,padding:"4px 20px 8px",marginBottom:16}}>
      <div style={{fontSize:13,fontWeight:700,color:T.textSoft,padding:"14px 0 8px",letterSpacing:0.5}}>More</div>
      <Row emoji="📈" label="Subscription" onClick={()=>{
        const n=adminTaps+1;
        setAdminTaps(n);
        if(n===3){setShowAdmin(true);setAdminTaps(0);}
        else{window.open("https://franco.app?subscribe=1","_blank");}
      }}/>
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
      <Row emoji="🍁" label="Immigration Services — Newton Immigration" onClick={()=>window.open("https://wa.me/16046355031","_blank")}/>
      <Row emoji="📞" label="Contact Us" onClick={()=>window.open("mailto:admin@junglelabsworld.com","_blank")}/>
      <Row emoji="📱" label="WhatsApp — +1 604 902 8699" onClick={()=>window.open("https://wa.me/16049028699","_blank")}/>
      <Row emoji="🔄" label="Re-take Self Assessment" onClick={()=>{if(window.confirm("Reset your level selection?"))onReset();}}/>
      <div onClick={()=>window.open("https://franco.app/privacy","_blank")} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 0",cursor:"pointer"}}
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

    {!guestMode&&user&&<div style={{marginTop:8,textAlign:"center"}}>
      {!showDeleteConfirm
        ? <button onClick={handleDeleteAccount} style={{background:"none",border:"none",color:"#EF4444",fontSize:13,cursor:"pointer",textDecoration:"underline"}}>Delete Account</button>
        : <div style={{background:"#FEF2F2",borderRadius:12,padding:"12px 16px",border:"1px solid #FECACA"}}>
            <div style={{fontSize:13,color:"#991B1B",fontWeight:600,marginBottom:8}}>⚠️ Delete your account permanently?</div>
            <div style={{fontSize:12,color:"#7F1D1D",marginBottom:12}}>This will erase all your progress and cannot be undone.</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setShowDeleteConfirm(false)} style={{flex:1,padding:"8px",background:"#fff",border:"1px solid #E2E8F0",borderRadius:8,fontSize:13,cursor:"pointer"}}>Cancel</button>
              <button onClick={handleDeleteAccount} disabled={deleteLoading} style={{flex:1,padding:"8px",background:"#EF4444",border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                {deleteLoading?"Deleting...":"Yes, Delete"}
              </button>
            </div>
          </div>
      }
    </div>}
    <div style={{textAlign:"center",fontSize:12,color:T.textSoft,marginTop:8}}>Powered by Jungle Labs</div>
  </div>;
}


function TopBar({screen,onNavigate,companion,progress,user,guestMode,onAuthNav}){
  const{logout}=useAuth();
  const isMobile=useIsMobile();
  const handleLogout=async()=>{ await logout(); window.location.reload(); };
  const nav=[
    {id:"dashboard",label:"Home",emoji:"🏠"},
    {id:"hub",label:"Learn",emoji:"📚"},
    {id:"practice",label:"Practice",emoji:"⚡"},
    {id:"profile",label:"Profile",emoji:"👤"},
  ];
  return <div style={{background:"#fff",borderBottom:"1px solid #E2E8F0",padding:"0 16px",display:"flex",alignItems:"center",height:52,gap:0,position:"sticky",top:0,zIndex:100,boxShadow:"0 1px 4px rgba(0,0,0,0.04)"}}>
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
  const[guestMode,setGuestMode]=useLocalState("franco_guest",false);

  // Check if returning from Stripe payment
  useEffect(()=>{checkStripeSuccess();},[]);

  useEffect(()=>{
    const s=document.createElement("style");
    s.textContent=`
      
      *{box-sizing:border-box;margin:0;padding:0;}
      body{background:${T.surface};}
      @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
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
  const handleStartLesson=(lesson,level)=>{
    if(!isLessonFree(lesson.id) && !isPremiumUnlocked()){ setPaywallLesson(lesson); return; }
    setActiveLesson({lesson,level}); setScreen("lesson");
  };
  const handleLessonComplete=(lessonId, score=4)=>{
    const newProgress={...progress,[lessonId]:true};
    const today=new Date().toISOString().split("T")[0];
    // Update streak
    const lastDay=localStorage.getItem("franco_last_day");
    const yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);
    const yStr=yesterday.toISOString().split("T")[0];
    let newStreak=parseInt(localStorage.getItem("franco_streak")||"0");
    if(lastDay===today){ /* same day */ }
    else if(lastDay===yStr){ newStreak+=1; }
    else{ newStreak=1; }
    localStorage.setItem("franco_streak",String(newStreak));
    localStorage.setItem("franco_last_day",today);
    // Update XP
    const newXP=(parseInt(localStorage.getItem("franco_xp")||"0"))+25;
    localStorage.setItem("franco_xp",String(newXP));
    setProgress(newProgress);
    // Schedule spaced repetition review
    const currentReviews=authCtx?.reviewSchedule||{};
    const prev=currentReviews[lessonId]||{};
    const nextReview=calcNextReview(prev.interval||0, prev.ef||2.5, score);
    const newReviews={...currentReviews,[lessonId]:nextReview};
    // Save everything to Firebase
    if(authCtx?.user && authCtx?.saveProgress){
      authCtx.saveProgress(newProgress, newXP, newStreak, newReviews);
    }
    setScreen("hub");
    setActiveLesson(null);
  };

  // Loading spinner while Firebase initializes
  if(initializing) return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F7FAFF",flexDirection:"column",gap:16}}>
      <div style={{fontSize:48,animation:"float 1.5s ease-in-out infinite"}}>🍁</div>
      <div style={{fontFamily:"system-ui,-apple-system,sans-serif",fontSize:14,color:"#475569"}}>Loading Franco...</div>
    </div>
  );

  // Auth screens (not logged in and not guest)
  const isAuthed = !!user || guestMode;
  if(!isAuthed){
    if(authScreen==="login") return <LoginScreen onNavigate={goAuth} prefillEmail={authParams.prefillEmail||""} notice={authParams.notice||""}/>;
    if(authScreen==="register") return <RegisterScreen onNavigate={goAuth}/>;
    return <AuthLandingScreen onNavigate={goAuth} onGuest={()=>{ setGuestMode(true); setAuthScreen("app"); }}/>;
  }

  // Main app
  const showNav=!["welcome","onboarding","lesson"].includes(screen);
  return <div style={{fontFamily:"system-ui,-apple-system,sans-serif",background:T.surface,minHeight:"100vh",color:T.text}}>
    {showNav&&<TopBar screen={screen} onNavigate={setScreen} companion={companion} progress={progress} user={user} guestMode={guestMode} onAuthNav={goAuth}/>}
    {screen==="welcome"&&<WelcomeScreen onNext={()=>setScreen(companion?"dashboard":"onboarding")}/>}
    {screen==="onboarding"&&<OnboardingScreen onComplete={handleOnboard}/>}
    {screen==="dashboard"&&<DashboardScreen companion={companion} startLevel={startLevel} progress={progress} onNavigate={setScreen} user={user} guestMode={guestMode}/>}
    {screen==="hub"&&<HubScreen progress={progress} onStartLesson={handleStartLesson}/>}
    {screen==="lesson"&&activeLesson&&<LessonScreen lesson={activeLesson.lesson} level={activeLesson.level} companion={companion} onComplete={handleLessonComplete} onBack={()=>setScreen("hub")}/>}
    {screen==="practice"&&<PracticeScreen companion={companion}/>}
    {screen==="tutor"&&<PersonalTutorScreen companion={companion} progress={progress} startLevel={startLevel} onNavigate={setScreen}/>}
    {screen==="profile"&&<ProfileScreen companion={companion} progress={progress} startLevel={startLevel} onReset={()=>{setProgress({});setScreen("dashboard");}} user={user} guestMode={guestMode} onAuthNav={goAuth}/>}
    {paywallLesson&&<PaywallModal lessonTitle={paywallLesson.title} onClose={()=>setPaywallLesson(null)}/>}
  </div>;
}

export default function App(){
  return <AuthProvider><AppInner/></AuthProvider>;
}
