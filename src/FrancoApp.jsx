import { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } from "react";
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
      if(u){
        // Check backend for premium status
        checkBackendPremium(u.uid);
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
  mkL("a2-01","Passé Composé with Avoir",30,"writing",
    "The main past tense for completed actions! Formula: avoir conjugated + past participle. Past participle rules: -ER → -É (manger→mangé), -IR → -I (finir→fini), -RE → -U (vendre→vendu). Common irregular: faire→fait, prendre→pris, voir→vu, boire→bu, écrire→écrit, lire→lu, dire→dit, être→été, avoir→eu.",
    ["j'ai mangé (I ate)","tu as fini (you finished)","il a fait (he did/made)","nous avons pris (we took)","vous avez vu (you saw)","ils ont bu (they drank)","j'ai écrit (I wrote)","j'ai eu (I had)","j'ai été (I was — using avoir!)"],
    [mcq("Past participle of 'prendre' (to take):",["prendu","prendé","pris","prené"],2,"Prendre → pris (irregular!). Common irregular past participles: faire→fait, prendre→pris, voir→vu, boire→bu, écrire→écrit, lire→lu, dire→dit. These must be memorized — no rule covers them!"),
     mcq("'Nous avons regardé la télé hier soir' means:",["We're watching TV this evening","We watched TV last night","We will watch TV tonight","We should watch TV tonight"],1,"Nous avons regardé = we watched (passé composé = completed past action). 'Hier soir' = last night/yesterday evening. This sentence could appear in any CLB 4 listening or reading task!"),
     mcq("'J'ai eu un rendez-vous ce matin' means:",["I have an appointment this morning","I had an appointment this morning","I will have an appointment this morning","I need an appointment this morning"],1,"J'ai eu = I had (past). 'Avoir' in passé composé = j'ai eu (irregular!). 'J'ai eu un rendez-vous ce matin' = I had an appointment this morning — past and finished!"),
     wr("Put into passé composé: 'je mange une pomme'",["j'ai mangé une pomme"],"J'ai mangé une pomme — manger → mangé (-ER verb). J'ai + mangé. Notice the cedilla stays! 'J'ai mangé à la cafétéria ce midi' = I had lunch at the cafeteria today. Perfect A2 usage!")]),

  mkL("a2-02","Passé Composé with Être",30,"writing",
    "17 verbs use ÊTRE not avoir! Memory trick: Dr and Mrs VANDERTRAMP: Devenir, Revenir, Monter, Rester, Sortir, Venir, Aller, Naître, Descendre, Entrer, Rentrer, Tomber, Retourner, Arriver, Mourir, Partir. Plus ALL reflexive verbs! CRITICAL: past participle agrees with subject! Elle est arrivée (+e), Ils sont partis (+s), Elles sont venues (+es).",
    ["je suis allé(e)","tu es venu(e)","elle est arrivée (+e feminine)","nous sommes partis (+s plural)","vous êtes rentré(e)(s)","elles sont sorties (+es f.pl.)","je me suis levé(e)","il s'est habillé"],
    [mcq("A woman says she went to the pharmacy. She says:",["Je suis allé à la pharmacie","Je suis allée à la pharmacie","J'ai allé à la pharmacie","J'ai allée à la pharmacie"],1,"Aller uses être → je suis allée (female: +e). Male: je suis allé. Agreement is mandatory with être! 'J'ai allé' is NEVER correct — aller ALWAYS uses être in passé composé."),
     mcq("'Elle est tombée dans l'escalier' means:",["She went up the stairs","She is climbing the stairs","She fell on the stairs","She ran up the stairs"],2,"Tomber (to fall) uses être → elle est tombée. Agreement: elle (f.) → tombée (+e). 'Dans l'escalier' = on/in the stairs. Tomber is in the DR MRS VANDERTRAMP list!"),
     wr("Say 'I woke up late this morning' (female speaker)",["je me suis réveillée tard ce matin","je me suis réveillée ce matin","je me suis réveillée tôt ce matin"],"Je me suis réveillée tard ce matin — reflexive verb uses être! Female speaker → réveillée (+e). 'Tard' = late. This is a perfect passé composé + reflexive sentence for A2/CLB 4!")]),

  mkL("a2-03","L'Imparfait — Past Description",30,"writing",
    "The imparfait is for ongoing past actions, descriptions, and habits in the past (contrast with passé composé for completed events). Formation: take NOUS form present, drop -ONS, add: -ais, -ais, -ait, -ions, -iez, -aient. Only exception: être → ét- (base). Uses: 'Quand j'étais enfant...' (when I was a child), descriptions of the past, interrupted actions, repeated habits.",
    ["base = nous form - ons: parlons → parl-","je parlais, tu parlais, il parlait","nous parlions, vous parliez, ils parlaient","être → j'étais, tu étais, il était...","habitude passée (repeated habit)","description passée (past description)","action interrompue (interrupted action)","Quand j'étais jeune, je..."],
    [mcq("'Quand j'étais enfant, j'habitais à Lyon.' The imparfait is used because:",["it's a completed action","it describes a past habit/state","it's a future plan","it's a wish"],1,"Imparfait = past habits, states, ongoing situations. 'J'habitais à Lyon quand j'étais enfant' = I used to live in Lyon when I was a child. Not a single event — an ongoing situation in the past!"),
     mcq("Base for imparfait of 'manger': take 'nous mangeons', remove -ons → ___",["mange-","mangons-","mango-","mang-"],3,"Nous mangeons → remove -ons → mang- BUT keep the 'e' for pronunciation before -ais! So: je mangeais (not je mangais). The 'e' prevents the G from becoming hard before 'a'. Exception for manger!"),
     wr("Say 'When I was young, I played sports every weekend'",["quand j'étais jeune, je faisais du sport tous les weekends","quand j'étais jeune je jouais au sport chaque weekend","quand j'étais jeune, je jouais au sport tous les weekends"],"Quand j'étais jeune, je jouais au sport tous les weekends — both verbs in imparfait (ongoing past state + repeated past habit). This sentence structure appears in CLB 4-5 speaking tasks about your background!")]),

  mkL("a2-04","Passé Composé vs Imparfait",30,"writing",
    "The key distinction for A2! Passé composé = specific completed event (it happened once, it's done). Imparfait = ongoing state, description, or repeated habit in the past. Classic pair: 'Je lisais quand le téléphone a sonné' = I was reading (imparfait — ongoing) when the phone rang (passé composé — specific event that interrupted). Think: imparfait = background/stage, passé composé = action/event.",
    ["passé composé = action précise, terminée","imparfait = état, habitude, description","je lisais (I was reading — ongoing)","le téléphone a sonné (it rang — event)","hier il faisait beau (it was nice — state)","il a plu à 14h (it rained at 2pm — event)","Signal words: soudain, tout à coup → PC","Signal words: d'habitude, souvent → IMP"],
    [mcq("'Il faisait froid quand je ___ au bureau.' (passé composé verb)",["arrivais","arriver","suis arrivé","arrivé"],2,"Faisait = imparfait (ongoing weather condition). Suis arrivé = passé composé (specific moment of arrival). The imparfait sets the background (it was cold), the passé composé describes the event (I arrived)!"),
     mcq("'D'habitude, elle ___ le bus.' (She usually took the bus — imparfait)",["a pris","prenait","prend","va prendre"],1,"D'habitude (usually) signals imparfait — it's a repeated habit! 'Elle prenait le bus d'habitude' = she used to take the bus usually. If it happened once specifically: 'Elle a pris le bus hier' (passé composé)."),
     wr("Use both tenses: 'I was eating when my phone rang'",["je mangeais quand mon téléphone a sonné","je mangeais quand le téléphone a sonné"],"Je mangeais (imparfait — ongoing) quand mon téléphone a sonné (passé composé — event that interrupted). This is THE model sentence for passé composé vs imparfait! Used in CLB 5 storytelling tasks.")]),

  mkL("a2-05","The Futur Simple",25,"writing",
    "Future tense for plans, predictions, and promises! Formation: INFINITIVE + endings: -ai, -as, -a, -ons, -ez, -ont. For -RE verbs, drop the final E first: prendre → prendr- + ai. Key irregular futures (must memorize): être→ser-, avoir→aur-, aller→ir-, faire→fer-, venir→viendr-, pouvoir→pourr-, vouloir→voudr-, devoir→devr-, savoir→saur-.",
    ["parler → je parlerai","finir → tu finiras","prendre → il prendra","aller → nous irons (irregular!)","faire → vous ferez (irregular!)","être → ils seront (irregular!)","avoir → j'aurai (irregular!)","quand + futur (when it happens...)"],
    [mcq("'Je ___ médecin dans 10 ans.' (I will be a doctor in 10 years.)",["vais être","serai","suis","serait"],1,"Serai = je + être in futur simple (irregular: ser-). 'Je serai médecin dans 10 ans' — expressing a long-term goal. Note: in everyday French, near future (je vais être) is more common for imminent plans, futur simple for more distant plans!"),
     mcq("Future of 'aller': 'Nous ___ au Canada l'an prochain.'",["allons","irons","allerons","allrons"],1,"Irons = nous + aller in futur simple. 'Aller' is completely irregular: j'irai, tu iras, il ira, nous irons, vous irez, ils iront. 'Nous irons au Canada l'an prochain' = We will go to Canada next year."),
     wr("Write a sentence about what you will do next year",["je serai","j'irai","je ferai","je travaillerai","j'aurai","je pourrai","j'apprendrai"],"Sample: 'L'année prochaine, j'aurai mon diplôme et je travaillerai dans un hôpital.' Future tense + specific time expression = CLB 5 speaking and writing!  Keep practicing future forms daily!")]),

  mkL("a2-06","Object Pronouns: Y and En",25,"writing",
    "'Y' replaces locations and complements with à: Je vais à Montréal → J'y vais. Il pense à son travail → Il y pense. 'EN' replaces quantities and complements with de: Je mange des fruits → J'en mange. Tu as besoin d'aide? → Tu en as besoin? J'ai deux enfants → J'en ai deux. Important: en and y go BEFORE the verb (like le, la, les)!",
    ["y = là (there) + complément avec 'à'","en = de là (from there) + complément avec 'de'","J'y vais (I'm going there)","J'en ai trois (I have three of them)","Tu en as besoin? (Do you need some/it?)","Vas-y! (Go ahead!)","Allons-y! (Let's go!)","Il y en a (There is/are some)"],
    [mcq("'Je pense à mon rendez-vous.' Replace 'à mon rendez-vous' with a pronoun:",["Je lui pense","Je le pense","J'y pense","J'en pense"],2,"Y replaces à + thing/place. 'Penser à' → y. J'y pense = I think about it. Y also replaces locations: Je vais au bureau → J'y vais. Important: y replaces THINGS/PLACES, not people (use lui/leur for people)!"),
     mcq("'Tu as de l'argent?' 'Oui, j'___ ai un peu.'",["le","la","y","en"],3,"En replaces de + noun. 'De l'argent' → en. 'J'en ai un peu' = I have a little of it. En also works with quantities: 'J'en ai trois' (I have three), 'Je n'en ai pas' (I have none)!"),
     wr("Replace location: 'Je vais à la pharmacie' using Y",["j'y vais"],"J'y vais — Y replaces 'à la pharmacie' (location). 'Tu vas à la réunion?' 'Oui, j'y vais.' Y = there. Also useful: 'Allons-y!' (Let's go!), 'Vas-y!' (Go ahead!). Very common in spoken Canadian French!")]),

  mkL("a2-07","Indirect Object Pronouns: Lui, Leur",25,"writing",
    "Indirect object pronouns replace à + PERSON. LUI = to him/her (singular), LEUR = to them (plural). They go BEFORE the verb! Common verbs with indirect objects: parler à (talk to), téléphoner à (call), donner à (give to), dire à (say to), demander à (ask), écrire à (write to), répondre à (respond to), expliquer à (explain to).",
    ["lui = to him/to her (indirect)","leur = to them (indirect)","BEFORE the verb!","Je lui parle (I speak to him/her)","Je leur écris (I write to them)","Je lui donne le formulaire","Ne confondez pas: le/la (direct) vs lui (indirect)"],
    [mcq("'Je parle à Marie.' Replace 'à Marie':",["Je la parle","Je lui parle","Je le parle","Je leur parle"],1,"Lui replaces à + person singular (Marie is singular). Je lui parle = I talk to her. Note: LUI replaces BOTH à + masculine AND à + feminine singular! 'Je parle à Paul → Je lui parle' and 'Je parle à Marie → Je lui parle.'"),
     mcq("'Elle donne les formulaires aux patients.' Replace 'aux patients':",["Elle les donne aux patients","Elle leur donne les formulaires","Elle lui donne les formulaires","Elle les leur donne"],1,"Leur replaces à + plural person. Aux patients → leur. 'Elle leur donne les formulaires' = She gives them the forms. Note: 'les formulaires' stays because it's the DIRECT object — you can't replace both at once in this step!"),
     wr("Say 'I wrote to him yesterday about the appointment'",["je lui ai écrit hier pour le rendez-vous","je lui ai écrit hier","je lui ai écrit à propos du rendez-vous"],"Je lui ai écrit hier pour le rendez-vous — passé composé + indirect object pronoun! Lui goes before 'ai écrit'. 'Pour le rendez-vous' = about/regarding the appointment. CLB 5+ sentence structure!")]),

  mkL("a2-08","Relative Clauses: Qui, Que, Où",25,"writing",
    "Relative pronouns connect two sentences! QUI = subject of the relative clause (replaces subject). QUE = object of relative clause (replaces object). OÙ = place or time where something happens. Examples: 'C'est le médecin QUI m'a opéré.' (subject — the doctor who operated on me) 'C'est le médicament QUE j'ai pris.' (object — the medication I took) 'C'est l'hôpital OÙ je suis né.' (place — the hospital where I was born).",
    ["qui = sujet du relatif (who/which — subject)","que/qu' = objet du relatif (that/which — object)","où = lieu ou temps (where/when)","C'est le médecin qui...","C'est l'hôpital que je cherche","C'est l'année où j'ai émigré","que becomes qu' before vowel"],
    [mcq("'C'est le formulaire ___ tu dois remplir.' (that you must fill out)",["qui","que","où","dont"],1,"Que — the formulaire is the OBJECT of 'remplir'. 'Tu dois remplir LE FORMULAIRE' → que replaces it. Que = when the noun is the object of the relative clause verb. Qui = when it's the subject."),
     mcq("'C'est le médecin ___ m'a aidé.' (who helped me)",["que","qui","où","lequel"],1,"Qui — le médecin is the SUBJECT of 'aidé' (the doctor helped me). 'LE MÉDECIN m'a aidé' → qui. Subject of the relative clause = qui!"),
     wr("Combine: 'Je cherche un appartement. Il est proche du métro.' Using qui or que.",["je cherche un appartement qui est proche du métro"],"Je cherche un appartement qui est proche du métro — 'qui' because l'appartement is the SUBJECT of 'est proche'. If object: 'C'est l'appartement que j'ai trouvé' (que, because it's the object of 'trouvé'). This structure appears in CLB 5+ writing!")]),

  mkL("a2-09","Conditional Tense",25,"speaking",
    "The conditional = 'would' — used for polite requests, hypothetical situations, and advice! Formation: same as futur simple BUT with imparfait endings: -ais, -ais, -ait, -ions, -iez, -aient. Same irregular bases as future: serait, aurait, irait, ferait, viendrait, pourrait, voudrait, devrait. Key uses: 'Je voudrais...' (I would like), 'Tu devrais...' (You should), 'Ce serait bien...' (It would be nice).",
    ["je voudrais (I would like — very common!)","tu devrais (you should)","il faudrait (it would be necessary)","nous pourrions (we could)","vous devriez (you should — formal)","Si j'avais de l'argent, j'achèterais...","Ce serait possible? (Would it be possible?)","À votre place, je... (In your place, I would...)"],
    [mcq("'___ vous répéter, s'il vous plaît?' (Could you repeat, please?)",["Pouviez","Pourriez","Pouvrez","Pouvez"],1,"Pourriez-vous = could you (conditional, polite). More polite than 'Pouvez-vous' (can you). In CLB formal contexts: always use conditional for requests! 'Pourriez-vous m'aider?' is more polite than 'Pouvez-vous m'aider?'"),
     mcq("'Tu devrais prendre ce médicament' means:",["You must take this medication","You will take this medication","You should take this medication","You took this medication"],2,"Tu devrais = you should (conditional of devoir). Softer than 'tu dois' (you must). 'Tu devrais voir un médecin' = You should see a doctor. Great for advice-giving in CLB speaking tasks!"),
     wr("Give advice: 'In your place, I would make an appointment right away'",["à votre place, je prendrais un rendez-vous tout de suite","à ta place, je prendrais un rendez-vous"],"À votre place, je prendrais un rendez-vous tout de suite — conditional of prendre (prendrais). 'À votre/ta place' = in your place/if I were you. Excellent CLB 5 advice-giving structure!")]),

  mkL("a2-10","Si Clauses (Conditional Sentences)",25,"writing",
    "Conditional sentences express hypothesis! Type 1 — Possible: SI + present + future: 'Si tu étudies, tu réussiras.' (If you study, you will succeed.) Type 2 — Hypothetical: SI + imparfait + conditionnel: 'Si j'avais de l'argent, j'achèterais une voiture.' (If I had money, I would buy a car.) Never use futur or conditionnel directly after SI!",
    ["Type 1: si + présent + futur","Type 2: si + imparfait + conditionnel","JAMAIS conditionnel après si!","Si tu as besoin, je t'aiderai (type 1)","Si j'étais riche, je voyagerais (type 2)","Si vous êtes disponible, appelez-moi","Qu'est-ce que tu ferais si...?"],
    [mcq("'Si je ___ le temps, j'apprendrais plus de langues.' (Hypothetical)",["ai","aurai","avais","aurais"],2,"Si + imparfait (avais) + conditionnel (apprendrais). Hypothetical = imparfait after si! 'Si j'avais le temps' = if I had the time (but I don't). Never: 'si j'aurais' — conditionnel NEVER follows si!"),
     mcq("'Si tu viens demain, on ___ au restaurant.' (Possible plan)",["aller","irons","irions","allons"],1,"Si + présent (tu viens) + futur (irons). Possible plan = present after si + future in main clause! 'Si tu viens demain, on ira au restaurant' = If you come tomorrow, we'll go to the restaurant (it's possible!)."),
     wr("Complete: 'Si j'habitais au Québec, je...'",["si j'habitais au québec, je parlerais","si j'habitais au québec, j'irais","si j'habitais au québec, je ferais","si j'habitais au québec, j'apprendrais"],"Si j'habitais au Québec, je parlerais français tous les jours! — Hypothetical type 2: si + imparfait (habitais) + conditionnel (parlerais). This sentence structure is common in CLB 5 writing tasks about your aspirations!")]),

  // A2 lessons 11-40 - abbreviated structure
  // ── A2 LESSONS 11–40 (real content) ──────────────────────────────────────
  mkL("a2-11","Passé Récent: Venir de + Infinitif",20,"speaking",
    "Express something that JUST happened! Formula: venir de (conjugated present) + infinitive. Je viens de manger (I just ate), Tu viens d'arriver (You just arrived), Il vient de partir (He just left), Nous venons de finir (We just finished). Very natural in spoken French — replaces long explanations like 'il y a quelques minutes'. In the past: il venait de partir quand je suis arrivé (he had just left when I arrived).",
    ["je viens de + infinitif","tu viens de","il/elle vient de","nous venons de","vous venez de","ils/elles viennent de","venir de = just did (présent)","venait de = had just (passé — imparfait)"],
    [mcq("'Il vient de téléphoner' means:",["He is going to call","He just called","He was calling","He should call"],1,"Vient de + infinitif = just did. 'Il vient de téléphoner' = He just called (moments ago). Very useful: 'Le médecin vient de vous appeler' = The doctor just called you. Venir de is always present tense for 'just now'!"),
     mcq("'Je viens d'arriver au Canada' means:",["I am going to arrive in Canada","I had just arrived in Canada","I just arrived in Canada","I am arriving in Canada"],2,"Je viens d'arriver = I just arrived. The d' is elision of 'de' before 'arriver' (starts with vowel). This phrase is perfect for introductions: 'Je viens d'arriver au Canada — je cherche du travail.'"),
     mcq("In the past: 'Elle ___ de partir quand tu as appelé.'",["vient","venait","est venue","va"],1,"Venait de + inf = had just done (imperfect). 'Elle venait de partir quand tu as appelé' = She had just left when you called. The imparfait of venir + de sets up an interrupted action — very common in narratives!"),
     wr("Say 'I just received my health card'",["je viens de recevoir ma carte-santé","je viens de recevoir ma carte santé"],"Je viens de recevoir ma carte-santé — viens de + recevoir (irregular past part. = reçu, but here it's infinitive!). Great sentence for a newcomer milestone. 'Je viens juste de...' is also used in informal Quebec French!")]),

  mkL("a2-12","Futur Proche vs Futur Simple",25,"speaking",
    "Both express future, but differently! FUTUR PROCHE (aller + inf): imminent, planned, certain — 'Je vais appeler demain' (I'm going to call tomorrow — I'm sure). FUTUR SIMPLE (inf + endings): more distant, formal, less certain, general truths — 'Un jour, je parlerai parfaitement' (One day, I will speak perfectly). In everyday Quebec French, futur proche is used FAR more often. Futur simple appears in written French, news, predictions, and formal contexts.",
    ["futur proche = plan immédiat/certain","futur simple = distant/formel/général","Ce soir, je vais regarder... (imminent)","Dans 10 ans, je travaillerai... (distant)","quand tu arriveras, appelle-moi! (futur simple après quand)","si tu viens, on ira (futur après si-présent)","futur simple = news, predictions, formal writing"],
    [mcq("Which is more natural in spoken Quebec French for 'I'm going to eat dinner'?",["Je mangerai ce soir","Je vais manger ce soir","Je mangerais ce soir","Je mangé ce soir"],1,"Je vais manger = near future (spoken). Futur proche dominates everyday conversation in Quebec. Futur simple (je mangerai) sounds formal/literary in spoken contexts — save it for writing or emphasis!"),
     mcq("'Quand tu ___ (arriver), appelle-moi!' — what tense after 'quand' for future meaning?",["vas arriver","arriveras","arrives","arrivais"],1,"After 'quand' with future meaning = FUTUR SIMPLE! 'Quand tu arriveras' (not 'quand tu vas arriver'). This is a key rule: quand, dès que, lorsque, aussitôt que + future = futur simple, not near future!"),
     wr("Write a sentence about a distant life goal using futur simple",["je serai","j'aurai","je vivrai","je travaillerai","je parlerai","j'irai"],"Dans cinq ans, je parlerai couramment français et j'aurai un bon emploi au Canada. — Futur simple for distant goals! 'Dans X ans' + futur simple is a perfect CLB 5 speaking structure for expressing ambitions.")]),

  mkL("a2-13","Relative Clauses: Dont and Lequel",25,"writing",
    "Advanced relative pronouns! DONT replaces de + noun: 'C'est le médicament DONT j'ai besoin' (the medication I need — besoin DE). 'C'est le collègue DONT je t'ai parlé' (the colleague I told you about — parler DE). LEQUEL/LAQUELLE/LESQUELS/LESQUELLES replaces à/avec/pour/dans + noun: 'Le bureau dans lequel je travaille' (the office in which I work). Remember: à + lequel = AUQUEL, de + lequel = DUQUEL.",
    ["dont = de qui/de quoi (replaces de+noun)","avoir besoin de → dont","parler de → dont","lequel/laquelle (m/f singular)","lesquels/lesquelles (m/f plural)","dans lequel (in which)","avec laquelle (with which)","auquel = à + lequel","duquel = de + lequel"],
    [mcq("'C'est l'appartement ___ j'ai besoin.' (I need this apartment — avoir besoin DE)",["que","qui","dont","lequel"],2,"Dont — because 'avoir besoin DE'. Dont replaces de + noun. 'C'est l'appartement dont j'ai besoin' = the apartment I need. Dont also replaces: parler de, se souvenir de, être fier de, avoir peur de..."),
     mcq("'Le médecin avec ___ je travaille est excellent.'",["qui","que","dont","lequel"],3,"Avec lequel — preposition (avec) + lequel replaces 'avec ce médecin'. When a preposition precedes the relative pronoun, use lequel (not que or qui). With people: 'avec qui' also works: 'Le médecin avec qui je travaille.'"),
     wr("Combine: 'J'ai un ami. Je parle souvent de cet ami.'",["j'ai un ami dont je parle souvent","j'ai un ami dont je parle souvent."],"J'ai un ami dont je parle souvent — parler DE → dont. 'Dont' replaces 'de cet ami'. Compare: 'J'ai un ami que je vois souvent' (que replaces direct object). Dont vs que = parler DE vs voir/appeler directly!")]),

  mkL("a2-14","Discours Indirect (Reported Speech)",25,"writing",
    "Reporting what someone said! Direct: Il dit 'Je viens demain.' → Indirect: Il dit qu'il vient demain. Key changes when reporting PAST speech: present → imparfait, futur → conditionnel, passé composé → plus-que-parfait. Pronouns change too: 'je' → 'il/elle'. Time words change: demain → le lendemain, hier → la veille, ce soir → ce soir-là. Introducing verbs: dire que, expliquer que, ajouter que, préciser que, confirmer que.",
    ["dire que (to say that)","expliquer que (to explain that)","Il dit qu'il vient (present → présent)","Il a dit qu'il venait (present → imparfait)","Il a dit qu'il viendrait (futur → conditionnel)","demain → le lendemain","hier → la veille","ici → là"],
    [mcq("Direct: 'Je travaille à l'hôpital.' → Indirect: Elle a dit qu'elle...",["travaille à l'hôpital","travaillait à l'hôpital","a travaillé à l'hôpital","travaillera à l'hôpital"],1,"Travaillait — when reporting PAST speech (elle a dit), present → imparfait. 'Elle a dit qu'elle travaillait à l'hôpital.' If reporting present speech: 'Elle dit qu'elle travaille à l'hôpital' (no tense change)."),
     mcq("Direct: 'Je viendrai demain.' → Il a dit qu'il...",["vient le lendemain","viendra le lendemain","viendrait le lendemain","venait le lendemain"],2,"Viendrait le lendemain — futur → conditionnel when reporting past speech. And 'demain' → 'le lendemain' (the next day). 'Il a dit qu'il viendrait le lendemain' = He said he would come the next day."),
     wr("Report this: 'Je suis arrivé hier.' (past speech)",["il a dit qu'il était arrivé la veille","elle a dit qu'elle était arrivée la veille","il a dit qu'il était arrivé hier"],"Il/Elle a dit qu'il/elle était arrivé(e) la veille — passé composé → plus-que-parfait (avait + pp) when reporting past. 'Hier' → 'la veille'. This level of reported speech shows real CLB 5-6 grammar control!")]),

  mkL("a2-15","Vocabulary: Health & Pharmacy Deep Dive",25,"speaking",
    "Complete health vocabulary for Canada! At the clinic: prendre un rendez-vous (book appointment), salle d'attente (waiting room), ordonnance (prescription), renouveler une ordonnance (renew prescription), résultats (test results), analyses de sang (blood tests). At the pharmacy: médicament sur ordonnance (prescription medication), sans ordonnance (over the counter), posologie (dosage instructions), effets secondaires (side effects), allergie (allergy), remboursement (reimbursement).",
    ["ordonnance (prescription)","renouveler (to renew)","la salle d'attente (waiting room)","les analyses de sang (blood tests)","posologie (dosage)","effets secondaires (side effects)","sans ordonnance (OTC)","remboursement (reimbursement/coverage)","médecin de famille (family doctor)","CLSC (community health centre)","urgence (emergency room)"],
    [mcq("'Ce médicament est sur ordonnance' means:",["This medication is over the counter","This medication requires a prescription","This medication is dangerous","This medication is free"],1,"Sur ordonnance = by prescription only. Sans ordonnance = OTC (over the counter). 'Est-ce que ce médicament est disponible sans ordonnance?' = Is this medication available without a prescription? Very common pharmacy question in Canada!"),
     mcq("'Je veux renouveler mon ordonnance' means:",["I want to fill my prescription for the first time","I want to renew/refill my prescription","I want to cancel my prescription","I want a new prescription"],1,"Renouveler = to renew/refill. 'Mon ordonnance expire bientôt, je voudrais la renouveler.' = My prescription is expiring soon, I'd like to renew it. Very important for managing ongoing medications in Canada!"),
     mcq("'Le CLSC' in Quebec is:",["a pharmacy chain","a private clinic","a community health centre (publicly funded)","a hospital emergency room"],2,"CLSC = Centre local de services communautaires. Free, publicly funded community health centres throughout Quebec offering medical care, social services, and vaccination clinics. Great resource for newcomers — no need for a family doctor for basic services!"),
     wr("Tell the pharmacist you have a side effect from your medication",["j'ai un effet secondaire","je ressens des effets secondaires","j'ai une réaction","ce médicament me cause des problèmes"],"J'ai des effets secondaires avec ce médicament — je ressens des nausées / des vertiges / des douleurs. Pharmacists in Quebec are highly accessible — you can walk in without an appointment for medication advice!")]),

  mkL("a2-16","Vocabulary: Housing & Rental in Canada",25,"reading",
    "Navigating Quebec's rental market! Key terms: bail (lease), propriétaire/locateur (landlord), locataire (tenant), loyer (rent), dépôt/dépôt de garantie (deposit — NOT legal in Quebec for residential!), charges comprises (utilities included), chauffage inclus (heat included), stationnement (parking), animaux acceptés (pets allowed), avis d'éviction (eviction notice), Régie du logement/TAL (tenant tribunal).",
    ["bail (lease)","propriétaire/locateur (landlord)","locataire (tenant)","le loyer (rent)","avis (notice — 60/90 days)","charges comprises (utilities included)","chauffage inclus (heat included)","TAL (Tribunal administratif du logement)","La Régie = old name for TAL","mois de dépôt = ILLÉGAL au Québec!"],
    [mcq("In Quebec, a landlord asking for a damage deposit (mois de dépôt) is:",["standard practice","required by law","illegal under Quebec law","optional but common"],2,"Deposits for residential rentals are ILLEGAL in Quebec! 'Au Québec, les dépôts de garantie sont interdits par la loi.' Only rent for first month can be asked. This protects tenants — know your rights! The TAL (formerly Régie du logement) enforces tenant rights."),
     mcq("'Chauffage inclus dans le loyer' means:",["You pay for heating separately","Heating is included in the rent","There is no heating in the unit","You choose your heating provider"],1,"Chauffage inclus = heating included in rent. Very important distinction in Quebec — winters are expensive to heat! Ads also show: eau chaude incluse (hot water included), électricité (you pay), tout inclus (all utilities included)."),
     wr("Ask a landlord if pets are allowed",["est-ce que les animaux sont acceptés?","les animaux sont-ils permis?","acceptez-vous les animaux de compagnie?"],"Est-ce que les animaux sont acceptés? / Acceptez-vous les animaux de compagnie? — Always ask before signing! In Quebec, landlords cannot automatically refuse pets in existing leases (since 2023 law change). Know your rights as a tenant!")]),

  mkL("a2-17","Vocabulary: Banking & Financial Services",25,"reading",
    "Essential banking French for Canada! Opening an account: ouvrir un compte (open an account), compte chèques (chequing account), compte épargne (savings account), carte de débit (debit card), carte de crédit (credit card), NIP/PIN (PIN number), virement (wire transfer), virement automatique (automatic transfer), prélèvement (direct debit), relevé de compte (account statement), guichet automatique/GAB (ATM).",
    ["ouvrir un compte (open an account)","compte chèques/épargne","carte de débit/crédit","NIP (PIN number)","virement (transfer)","prélèvement (direct debit)","relevé de compte (statement)","guichet automatique/GAB (ATM)","commission/frais (fees)","taux d'intérêt (interest rate)","NAS (Numéro d'assurance sociale = SIN)"],
    [mcq("'Je voudrais ouvrir un compte chèques' — what are you doing?",["Cashing a cheque","Opening a savings account","Opening a chequing account","Applying for a credit card"],2,"Compte chèques = chequing account (for daily transactions). Compte épargne = savings account. When opening a bank account in Quebec, bring: passport, permanent resident card, and NAS (Social Insurance Number) if available!"),
     mcq("'Le virement a été effectué' means:",["The transfer was declined","The transfer was completed","The transfer is pending","The transfer was cancelled"],1,"Virement effectué = transfer completed. You'll see this in online banking. 'J'ai fait un virement' = I made a transfer. 'Virement automatique' = automatic payment setup. Very useful for paying rent, utilities, and subscriptions!"),
     wr("Ask how to set up automatic bill payment",["comment faire un prélèvement automatique?","comment mettre en place un virement automatique?","comment payer mes factures automatiquement?"],"Comment mettre en place un virement automatique pour mes factures? — virement automatique = automatic transfer. Very useful for rent, utilities, internet. The bank will ask for: compte source, montant, date, compte destinataire.")]),

  mkL("a2-18","Vocabulary: Canadian Government Services",25,"reading",
    "Navigating Canadian government services in French! Key services: Emploi et Développement social Canada (Employment and Social Development = EDSC), assurance-emploi (employment insurance = AE), Régie de l'assurance maladie du Québec (RAMQ), Service Canada, Revenu Canada/ARC (Canada Revenue Agency), numéro d'assurance sociale/NAS (SIN), déclaration de revenus (tax return), crédit d'impôt (tax credit), Aide sociale (social assistance).",
    ["Service Canada (federal services)","EDSC (Employment & Social Development Canada)","ARC / Revenu Canada (tax agency)","RAMQ (Quebec health insurance)","NAS (Numéro d'assurance sociale = SIN)","déclaration de revenus (tax return)","Aide sociale (social assistance)","Prestation canadienne (Canadian benefit)","guichet unique (one-stop service)","formulaire (form — fill many of these!)"],
    [mcq("'Le NAS' (Numéro d'assurance sociale) is equivalent to:",["your health card number","your passport number","your Social Insurance Number (SIN)","your bank account number"],2,"NAS = SIN (Social Insurance Number). 9-digit number required for: working in Canada, opening a bank account, filing taxes, accessing government benefits. Apply at any Service Canada office. PROTECT it — it's sensitive info!"),
     mcq("'L'assurance-emploi' (AE) is available when:",["you quit your job voluntarily","you're laid off or lose your job involuntarily","you've never worked in Canada","you're a student"],1,"Assurance-emploi (AE) = Employment Insurance. Available if laid off (not if you quit). You must have worked enough hours (420-700 depending on region). File within 4 weeks of losing your job at Service Canada!"),
     wr("Ask where to go to get your SIN number",["où est-ce que je peux obtenir mon NAS?","où puis-je faire une demande de NAS?","où se trouve le bureau de Service Canada?"],"Où est-ce que je peux obtenir mon NAS? — at any Service Canada office, free of charge. Bring your immigration documents (PR card, work permit, etc.). The NAS is issued same-day in most cases. Essential first step after arriving in Canada!")]),

  mkL("a2-19","Writing: Formal Email Request",30,"writing",
    "Write a formal email requesting information or a service. Structure: 1) Object: clear and specific. 2) Salutation: Bonjour Madame/Monsieur + name if known. 3) Opening: reason for writing (Je vous écris afin de / Suite à...). 4) Body: specific request + all necessary details. 5) Closing: thank them + indicate expected response (Dans l'attente de votre réponse). 6) Sign-off: Cordialement + full name + contact. Always use 'vous' and conditional for politeness.",
    ["Objet: (subject line)","Suite à notre échange... / Je vous écris afin de...","Pourriez-vous me faire parvenir...? (polite request)","Je souhaiterais savoir si...","Je vous serais reconnaissant(e) si...","Dans l'attente de votre réponse","Cordialement,","[Prénom NOM — Téléphone — Adresse]"],
    [mcq("The MOST polite way to make a request in a formal email:",["Je veux que vous m'envoyiez...","Envoyez-moi...","Pourriez-vous m'envoyer...?","Vous devez m'envoyer..."],2,"Pourriez-vous = conditional of pouvoir = could you. The conditional makes requests polite and professional. Always use in formal emails! 'Pourriez-vous me faire parvenir ce document?' = Could you send me this document?"),
     mcq("'Je vous serais reconnaissant(e)' means:",["I am grateful to you","I will be grateful to you","I would be grateful to you (conditional — very polite)","I was grateful to you"],2,"Je vous serais reconnaissant(e) = I would be grateful to you — conditional + reconnaissant = very formal and polite request ending. A level above 'je vous remercie'. Use for important requests to high-level contacts!"),
     wr("Write a subject line for an email requesting an employment reference letter",["objet : demande de lettre de référence","objet: demande de lettre de référence professionnelle"],"Objet : Demande de lettre de référence professionnelle — specific, professional, tells recipient what's needed before they open the email. Always capitalize first word of subject line in French professional emails.")]),

  mkL("a2-20","Writing: Letter to Landlord",25,"writing",
    "Write professional letters to your landlord! Situation types: reporting a repair needed (signaler une réparation), noticing problems (infiltration d'eau = water leak, chauffage insuffisant = insufficient heating), requesting rent receipt (reçu de loyer), giving notice to leave (avis de départ — 3 months in Quebec usually). Always: date the letter, keep a copy, send by registered mail for important matters, reference your lease and Quebec tenant rights (TAL).",
    ["Je vous écris au sujet de...","Il y a un problème avec... (there is a problem with)","Je vous demande de procéder aux réparations (please proceed with repairs)","Je vous avise de mon départ le... (I hereby notify you of my departure)","Conformément au bail (as per the lease)","Dans un délai raisonnable (within a reasonable timeframe)","Je conserve une copie de cette lettre (I'm keeping a copy)","À défaut, je me verrai contraint de... (failing this, I will be forced to...)"],
    [mcq("To report a repair needed to your landlord, you should:",["Call verbally and wait","Write a dated letter and keep a copy","Post on social media","Just fix it yourself and deduct from rent"],1,"Always write formal letters for repairs! A dated letter with your signature creates a paper trail. If landlord doesn't repair within reasonable time, you can file with the TAL. 'Je vous écris pour vous signaler...' + description of problem + 'Je vous demande de procéder aux réparations dans les meilleurs délais.'"),
     mcq("Notice to leave your apartment in Quebec is usually:",["1 month","2 months","3 months","6 months"],2,"3 months notice (avis de 3 mois) is standard for most Quebec leases. Check your bail! 'Je vous avise par la présente de mon intention de ne pas renouveler mon bail, qui prend fin le [date].' Send before the deadline to avoid automatic renewal!"),
     wr("Write the opening line of a repair request letter",["je vous écris pour signaler","je vous contacte au sujet d'un problème","bonjour, je vous écris","je vous informe d'un problème"],"Bonjour Madame/Monsieur [Name], Je vous écris pour vous signaler un problème d'infiltration d'eau dans ma salle de bain (appartement 3B). — Clear, polite, specific. Include: what the problem is, where it is, since when, and urgency!")]),

  mkL("a2-21","Writing: Explaining an Absence",20,"writing",
    "Write notes explaining absences for work or school. Work absence (billet d'absence): 'Je me permets de vous informer que je serai absent(e) le [date] en raison de [reason].' School absence for child: 'Veuillez excuser l'absence de mon enfant [name] le [date] pour cause de maladie.' Medical note: 'Le Dr. X certifie que M./Mme [Name] était dans l'incapacité de travailler du [date] au [date].' Always: date, signature, reason (brief), and duration.",
    ["Je vous informe de mon absence le... (I inform you of my absence on...)","En raison de... (due to...)","Pour cause de maladie (due to illness)","Veuillez excuser... (please excuse...)","Billet médical / certificat du médecin (medical note)","J'étais dans l'incapacité de (I was unable to)","Je serai de retour le... (I will return on...)","Avec mes excuses pour la gêne occasionnée (apologies for the inconvenience)"],
    [mcq("An informal school absence note should be addressed to:",["Le Gouvernement du Canada","Le Ministère de l'Éducation","L'enseignant(e) / Le directeur de l'école","Le médecin"],2,"Address to the teacher or principal! 'Madame/Monsieur [Nom de l'enseignant(e)],' then: 'Je vous informe que mon enfant [Prénom] était absent(e) le [date] pour cause de maladie. Veuillez l'excuser. Cordialement, [Your name].' Simple, specific, polite!"),
     mcq("'J'étais dans l'incapacité de me présenter au travail' means:",["I chose not to come to work","I forgot to come to work","I was unable to come to work","I came to work late"],2,"J'étais dans l'incapacité de = I was unable to (formal/medical). More formal than 'je n'ai pas pu' (I couldn't). Used in medical notes and formal absence explanations. 'Le médecin certifie que le patient était dans l'incapacité de travailler.'"),
     wr("Write a one-sentence work absence notice for tomorrow",["je vous informe que je serai absent","je vous avise de mon absence","je ne pourrai pas venir"],"Je vous informe que je serai absent(e) demain, le [date], pour cause de maladie. Je vous fournirai un billet médical à mon retour. — Professional, complete, follows French workplace norms. Always send BEFORE the absence if possible!")]),

  mkL("a2-22","Speaking: Describe a Past Experience",25,"speaking",
    "Describe past experiences in French using both past tenses correctly! Story structure: 1) Setting — imparfait (C'était en 2022, il faisait beau, j'habitais à...). 2) Events — passé composé (Soudain, j'ai rencontré..., Ensuite, nous avons...). 3) Description of feelings — imparfait (j'étais surpris, c'était incroyable). 4) Resolution — passé composé (Finalement, nous avons réussi à...). Practice with: my immigration experience, my first day at work/school in Canada, a memorable event.",
    ["D'abord, j'étais... (setting — IMP)","Puis, j'ai... (event — PC)","C'était + description (IMP)","Tout à coup / Soudain (suddenly — signals PC)","Ensuite / Après ça (then/after that)","Finalement / À la fin (finally)","J'ai ressenti / J'éprouvais (I felt)","C'était une expérience... (It was an experience...)"],
    [mcq("'Je marchais dans la rue quand j'ai vu mon ami.' Which is the 'background' action?",["j'ai vu","mon ami","je marchais","dans la rue"],2,"Je marchais (imparfait) = ongoing background action when the event happened. J'ai vu (passé composé) = the specific event that occurred. Classic imparfait-as-background + PC-as-event structure in storytelling!"),
     mcq("'Soudain' (suddenly) typically signals which tense?",["imparfait","présent","passé composé","futur"],2,"Soudain/Tout à coup = suddenly → passé composé! These time words signal a specific, sudden event. Similarly: alors (then), puis (then), ensuite (next) → passé composé for events. D'habitude, souvent, toujours → imparfait for habits/descriptions."),
     wr("Start a story: 'When I first arrived in Canada...'",["quand je suis arrivé au canada","quand je suis arrivée au canada","quand j'ai émigré au canada"],"Quand je suis arrivé(e) au Canada, j'étais nerveux/nerveu​se mais excité(e). C'était en [year]. Je ne parlais pas encore bien français... — Perfect narrative opening! This exact story is asked in CLB 5 speaking assessments: 'Parlez-moi de votre arrivée au Canada.'")]),

  mkL("a2-23","Speaking: Express a Problem & Solution",25,"speaking",
    "Describe problems and propose solutions — a core CLB 4-5 skill! Problem language: J'ai un problème avec... (I have a problem with), Malheureusement... (Unfortunately), Il y a une erreur dans... (There's an error in), Je me trouve dans une situation difficile (I'm in a difficult situation). Solution language: Je pense que la meilleure solution serait de... (best solution would be), Il faudrait... (It would be necessary to), Je propose de... (I propose to), Pourriez-vous... (Could you...).",
    ["J'ai un problème avec... (I have a problem with)","Il y a une erreur dans... (there's an error in)","Malheureusement,... (unfortunately)","Je propose de... (I propose to)","La solution serait de... (the solution would be)","Il faudrait... (it would be necessary to)","Je vous demande de bien vouloir... (I ask that you kindly...)","Pourriez-vous corriger...? (Could you correct...?)"],
    [mcq("'Il y a une erreur dans ma facture' is used to:",["pay a bill","report a billing error","ask for a discount","cancel a service"],1,"Il y a une erreur dans ma facture = there's an error in my bill/invoice. Useful for utilities, phone bills, medical bills. Follow with: 'Le montant facturé est de X$ mais il devrait être de Y$.' = The charged amount is $X but should be $Y."),
     mcq("'Je vous demande de bien vouloir corriger cette erreur' means:",["I demand you fix this","I kindly ask you to correct this error","I will correct this error","I noticed an error"],1,"Je vous demande de bien vouloir = I kindly ask you to — very polite and formal request structure. 'Bien vouloir' (please be so kind as to) adds extreme politeness. Used in formal complaint letters and professional requests!"),
     wr("Report that your internet hasn't worked for 3 days",["mon internet ne fonctionne pas depuis 3 jours","j'ai un problème avec mon internet depuis 3 jours","ma connexion internet est en panne depuis 3 jours"],"Mon internet ne fonctionne pas depuis 3 jours — depuis + présent (ongoing problem). Or: 'J'ai un problème de connexion internet depuis le [date]. Je vous demande de bien vouloir envoyer un technicien.' Full formal report for a service company!")]),

  mkL("a2-24","Speaking: Make Comparisons",20,"speaking",
    "Compare Canada, your home country, cities, or options! Structures: plus/moins/aussi + adj + que, le/la plus/moins + adj (superlative), comparatif avec noms: plus de/moins de/autant de, meilleur/pire for quality. Advanced: D'un côté... de l'autre (on one hand... on the other), En comparaison de (in comparison to), Par rapport à (compared to), Contrairement à (unlike/contrary to), Tandis que (while/whereas).",
    ["plus/moins/aussi + adj + que","le plus / le moins + adj (superlatif)","plus de / moins de / autant de + nom","par rapport à (compared to)","contrairement à (unlike)","tandis que / alors que (while/whereas)","d'un côté... de l'autre (on one hand... other)","en comparaison (in comparison)"],
    [mcq("'Le métro de Montréal est moins cher que le métro de Toronto.' This compares:",["cities","metro systems using moins...que","metro systems using plus...que","cities using superlative"],1,"Moins cher que = less expensive than. Plus cher que = more expensive than. Aussi cher que = as expensive as. Comparative with adj always uses plus/moins/aussi + adj + QUE!"),
     mcq("'Par rapport à mon pays d'origine, le Canada est...' This structure is used for:",["asking a question","expressing a preference","comparing Canada to your home country","asking for directions"],2,"Par rapport à = compared to/relative to. Very useful for CLB speaking tasks about integration and cultural adaptation. 'Par rapport à mon pays d'origine, le système de santé au Canada est très accessible.'"),
     wr("Compare two things you know well (cities, jobs, seasons...)",["par rapport à","contrairement à","tandis que","en comparaison","plus... que","moins... que"],"Par rapport à l'été, l'hiver canadien est beaucoup plus difficile. Cependant, contrairement à ce que je pensais, j'ai appris à l'apprécier. — Great CLB 5 comparison structure using contrast connectors!")]),

  mkL("a2-25","A2 Grammar Review: Tenses",25,"integrated",
    "Full review of all A2 tenses! 1) Passé Composé (specific past events) — avoir/être + past participle. 2) Imparfait (descriptions, habits, ongoing past) — base + endings. 3) PC vs IMP (background vs event). 4) Futur Simple (future plans/predictions) — infinitive + endings. 5) Conditionnel (would) — infinitive + IMP endings. 6) Si-clauses (possible: si+présent+futur; hypothetical: si+IMP+conditionnel). 7) Venir de (just did). 8) Discours indirect (tense changes).",
    ["PC: avoir/être + participe passé","IMP: base nous (- ons) + ais/ais/ait","PC vs IMP: événement vs description","Futur: infinitif + ai/as/a/ons/ez/ont","Conditionnel: infinitif + ais/ais/ait","Si présent → futur | Si IMP → conditionnel","Venir de + infinitif = just did","Discours indirect: tense backshift"],
    [mcq("'Si elle avait le temps, elle ___.' (conditional type 2)",["étudie","étudiera","étudierait","étudiait"],2,"Étudierait — si + imparfait → conditionnel. Type 2 (hypothetical): 'Si elle avait le temps, elle étudierait le français tous les jours.' The condition is NOT real — she doesn't have time. Imparfait after si, conditionnel in main clause!"),
     mcq("Choose the correct tense: 'D'habitude, je ___ le bus, mais hier j'___ un taxi.'",["prenais / ai pris","ai pris / prenais","prends / prenais","prenais / prenais"],0,"Prenais (imparfait — habit) + ai pris (passé composé — specific yesterday event). D'habitude signals imparfait, hier signals passé composé. Perfect PC vs IMP contrast sentence!"),
     wr("Write a sentence using conditionnel to express a wish",["je voudrais","j'aimerais","je souhaiterais","ce serait bien si","j'adorerais"],"J'aimerais travailler dans le domaine de la santé un jour — conditionnel of aimer. Or: 'Ce serait merveilleux de parler couramment français!' Conditionnel for wishes, dreams, and polite requests. CLB 5 speaking staple!")]),

  mkL("a2-26","A2 Grammar Review: Pronouns",25,"integrated",
    "All A2 pronouns mastered! Direct object: le/la/l'/les (replaces noun directly). Indirect object: lui/leur (replaces à + person). Y: replaces à + place/thing. En: replaces de + noun/quantity. Relative: qui (subject), que (object), dont (de+noun), où (location/time), lequel/laquelle (prep + noun). Key rule: pronoun order when multiple: NE + me/te/se/nous/vous + le/la/les + lui/leur + y + en + VERB + PAS.",
    ["le/la/l'/les (direct object)","lui/leur (indirect — à+person)","y (à+chose/lieu)","en (de+nom/quantité)","qui/que/dont/où (relatifs)","ordre: me/te/se > le/la/les > lui/leur > y > en","ne + pronoms + verb + pas (negation)"],
    [mcq("'Je lui en ai parlé' means:",["I spoke to him/her about it","I spoke about him/her there","I gave him/her some","I have it for him/her"],0,"Lui = to him/her (indirect), en = about it (replaces 'de + thing'). 'Je lui en ai parlé' = I spoke to him/her about it (parler À quelqu'un DE quelque chose → lui + en). Perfect CLB 5 pronoun stacking!"),
     mcq("Order of pronouns: 'Give me some' → 'Don't give ___.'",["me en donnez pas","m'en donnez pas","en me donnez pas","donnez me pas en"],1,"Ne m'en donnez pas — order: me comes before en. M' = me (before vowel). Complete order: me/te/se/nous/vous → le/la/les → lui/leur → y → en. 'Ne me le donnez pas, ne m'en donnez pas, n'y allez pas, ne lui en parlez pas!'"),
     wr("Replace both objects: 'Il donne le formulaire au patient.'",["il le lui donne"],"Il le lui donne — le = le formulaire (direct, masculine), lui = au patient (indirect). Order: le/la/les comes before lui/leur! 'Il le lui donne tous les matins' = He gives it to him every morning. CLB 5 grammar mastery!")]),

  mkL("a2-27","A2 Vocabulary: Technology & Digital Life",20,"reading",
    "Digital vocabulary for modern Canadian life! Un ordinateur (computer), un téléphone intelligent/cellulaire (smartphone), une application/appli (app), le courriel (email — use in Quebec!), un mot de passe (password), le réseau (network), wifi, télécharger (download), envoyer (send), partager (share), un compte (account), se connecter (log in), un identifiant (username), protection des données (data privacy).",
    ["le courriel (email — not 'email' formally)","le mot de passe (password)","se connecter (to log in)","un identifiant (username/login)","télécharger (download)","le réseau (network)","une appli/application","partager un lien (share a link)","protection de la vie privée (data privacy)","en ligne / hors ligne (online/offline)"],
    [mcq("In formal Quebec French, 'email' is called:",["email","courriel","texto","messagerie"],1,"Courriel = email in Quebec French (short for 'courrier électronique'). Officially promoted by the OQLF (Office québécois de la langue française). In France they use 'courriel' too, but 'e-mail' is also widely accepted. In formal Quebec contexts: ALWAYS 'courriel'!"),
     mcq("'Télécharger' means:",["to upload","to download","to share","to delete"],1,"Télécharger = to download. Téléverser = to upload (less common, 'uploader' is often used informally). 'Téléchargez l'application sur votre téléphone' = Download the app on your phone. Very common in tech instructions!"),
     wr("Write how to tell someone to reset their password",["réinitialisez votre mot de passe","changez votre mot de passe","allez sur la page de connexion"],"Réinitialisez votre mot de passe en cliquant sur 'Mot de passe oublié'. — réinitialiser = to reset. Very common in customer service French! Also: 'Votre mot de passe doit contenir au moins 8 caractères.' (must contain at least 8 characters)")]),

  mkL("a2-28","A2 Vocabulary: Environment & Nature",20,"reading",
    "Environmental vocabulary — increasingly important in Canada! L'environnement (environment), le changement climatique (climate change), les gaz à effet de serre (greenhouse gases), l'empreinte carbone (carbon footprint), le recyclage (recycling), la collecte des ordures (garbage collection), le bac de compost (compost bin), l'énergie renouvelable (renewable energy), la sécheresse (drought), les inondations (floods), la faune et la flore (wildlife and plants).",
    ["le changement climatique (climate change)","le recyclage (recycling)","le compost / composter","les énergies renouvelables","l'empreinte carbone (carbon footprint)","les inondations (floods)","la sécheresse (drought)","le développement durable (sustainable development)","réduire/réutiliser/recycler (reduce/reuse/recycle)","la collecte des déchets (waste collection)"],
    [mcq("'Le recyclage est obligatoire au Québec' means:",["Recycling is optional in Quebec","Recycling is mandatory in Quebec","Recycling is expensive in Quebec","Recycling is new in Quebec"],1,"Obligatoire = mandatory. Quebec has robust recycling programs: bac bleu (blue bin = recyclables), bac brun/compost (organics), résidus (garbage). Knowing this vocabulary helps you understand local environmental rules!"),
     mcq("'Les gaz à effet de serre' refers to:",["natural perfumes","greenhouse gases","seasonal allergies","gas heating systems"],1,"Gaz à effet de serre = greenhouse gases (literally 'greenhouse effect gases'). Canada has committed to reducing emissions by 40-45% by 2030. This topic appears regularly in CLB reading tasks and Canadian news!"),
     wr("Express your opinion on climate change in French",["le changement climatique est","je pense que l'environnement","à mon avis, nous devons","il est important de protéger"],"À mon avis, le changement climatique est l'un des défis les plus importants de notre époque. Il est essentiel de réduire notre empreinte carbone. — Opinion + justification. Perfect A2-B1 opinion sentence for CLB speaking tasks!")]),

  mkL("a2-29","A2 Vocabulary: Food & Canadian Cuisine",20,"speaking",
    "Food vocabulary for restaurants, grocery stores, and Quebec cuisine! Grocery: l'épicerie (grocery store), les produits frais (fresh produce), la boucherie (butcher), la fromagerie (cheese shop). Quebec specialties: la poutine, le sirop d'érable (maple syrup), la tourtière (meat pie), les cretons (pork spread), le smoked meat (from Montreal delis!). Cooking: faire cuire (cook), bouillir (boil), rôtir (roast), griller (grill), congeler (freeze).",
    ["l'épicerie (grocery store)","les produits frais (fresh produce)","la poutine (Quebec specialty!)","le sirop d'érable (maple syrup)","la tourtière (meat pie)","le smoked meat (Montreal deli staple)","faire cuire (to cook)","bouillir/rôtir/griller (boil/roast/grill)","congeler/décongeler (freeze/thaw)","sans gluten / sans lactose (diet restrictions)"],
    [mcq("'La poutine' is a Quebec dish consisting of:",["smoked meat and bread","fries, cheese curds, and gravy","maple syrup pancakes","French onion soup"],1,"Poutine = frites (fries) + fromage en grains (cheese curds) + sauce brune (gravy). Born in rural Quebec in the 1950s, now a Canadian icon! Fromage en grains = fresh cheese curds (they must squeak when fresh!). Essential Quebec cultural knowledge!"),
     mcq("'Êtes-vous sans lactose?' a restaurant asks because:",["they want to know your nationality","they're asking about a dairy intolerance","they're asking if you're vegetarian","they're checking if you have nut allergies"],1,"Sans lactose = lactose-free/lactose intolerant. Restaurants in Canada increasingly ask about dietary restrictions. Common questions: 'Avez-vous des allergies?' 'Êtes-vous végétarien(ne)?' 'Mangez-vous sans gluten?'"),
     wr("Describe your favourite Canadian food you've tried",["j'ai essayé","j'adore","c'est délicieux","je recommande","la poutine","le sirop d'érable","le smoked meat"],"J'ai essayé la poutine pour la première fois l'année dernière — c'était délicieux! Je recommande le smoked meat du Marché Jean-Talon à Montréal. — Past experience + recommendation = perfect CLB 4-5 speaking content!")]),

  mkL("a2-30","A2 Vocabulary: Sports & Leisure",20,"speaking",
    "Sports and activities vocabulary for Canada! Major Canadian sports: le hockey sur glace (ice hockey — THE national sport!), le curling, le patinage (skating), le ski, la raquette (snowshoeing), la randonnée (hiking), le vélo (cycling), la natation (swimming), le soccer (Canada uses 'soccer' not 'football'!). Talking about sports: assister à un match (attend a game), une équipe (team), les Canadiens de Montréal (Montreal's NHL team — 'les Habs'!).",
    ["le hockey sur glace (ice hockey)","les Canadiens de Montréal (the Habs!)","le curling","le patinage (skating)","la raquette (snowshoeing)","le ski alpin/nordique (downhill/cross-country)","assister à un match (attend a game)","une équipe (team)","la saison sportive (sports season)","les billets de saison (season tickets)"],
    [mcq("'Le hockey sur glace' is considered:",["a minor sport in Canada","THE national winter sport of Canada","only popular in Quebec","a recent arrival to Canada"],1,"Hockey is THE national winter sport of Canada (lacrosse is the official national summer sport). 'Les Canadiens de Montréal' (the Habs) are one of the most storied NHL franchises. Talking hockey is an instant connection-builder with Canadians!"),
     mcq("'Assister à un match de hockey' means:",["to watch hockey on TV","to play hockey","to attend a hockey game in person","to coach a hockey team"],1,"Assister à = to attend (in person). Not 'assister' in the English sense of 'help'! 'J'ai assisté à un match des Canadiens — c'était incroyable!' = I attended a Canadiens game — it was incredible! Perfect for CLB speaking conversation!"),
     wr("Say what sport you'd like to try in Canada",["j'aimerais essayer","je voudrais apprendre","j'ai envie d'essayer","je souhaiterais pratiquer"],"J'aimerais apprendre à patiner — c'est très typique du Canada! Conditio​nnel + sport = polite expression of wish. Or: 'J'ai envie d'essayer le curling, parce que c'est un sport très canadien!'")]),

  mkL("a2-31","A2 Reading: Understanding Notices",20,"reading",
    "Read and understand official notices in French — a CLB 4 core skill! Types: building notices (avis aux locataires = notice to tenants), school notices (avis aux parents), utility interruption notices (interruption de service), government notices (avis officiel). Key vocabulary: avis (notice), prendre note de (take note of), s'applique à (applies to), entrer en vigueur (take effect), sauf exception (unless otherwise), conformément à (in accordance with).",
    ["avis (notice/announcement)","à compter du... (as of / starting from)","entrer en vigueur (take effect)","s'appliquer à (to apply to)","prendre note de (take note of)","conformément à (in accordance with)","sauf avis contraire (unless otherwise notified)","dès réception (upon receipt)","ci-joint (enclosed/attached)"],
    [mcq("'À compter du 1er janvier' means:",["Before January 1st","As of / starting January 1st","Until January 1st","On January 1st only"],1,"À compter de = as of / starting from. 'À compter du 1er janvier, les nouvelles heures d'ouverture seront...' = Starting January 1st, the new hours will be... Very common in official announcements and policy changes!"),
     mcq("'Cet avis s'applique à tous les locataires' means:",["This notice is optional for tenants","This notice applies to all tenants","This notice is from all tenants","This notice is only for some tenants"],1,"S'appliquer à = to apply to. 'Tous les locataires' = all tenants. Standard language in building management notices. 'Le présent avis s'applique à l'ensemble des résidents de l'immeuble.'"),
     wr("Write what 'Interruption d'eau le mardi 15 mars de 9h à 15h' communicates",["il n'y aura pas d'eau","l'eau sera coupée","interruption du service d'eau","pas d'eau de 9h à 15h"],"The water will be shut off on Tuesday March 15 from 9am to 3pm. Practical building notices like this appear regularly in CLB reading tests. Key words: interruption (shutdown), de...à... (from...to), date and time!")]),

  mkL("a2-32","A2 Reading: Extracting Key Information",20,"reading",
    "CLB 4 reading skill: scan a text for specific information without reading every word! Strategy: 1) Read the question FIRST, 2) Identify key words to scan for, 3) Skim the text, 4) Find the answer section, 5) Read that section carefully. Texts: job postings (offres d'emploi), service descriptions, schedules (horaires), menus, advertisements, government information pages. Focus on: who, what, when, where, how much, requirements.",
    ["Technique: lire la question d'abord","Scanner = chercher les mots-clés","Offre d'emploi: exigences (requirements), salaire, horaire","Horaires: de...à..., sauf le...","Publicité: remise, conditions","Critères d'éligibilité","Poste à temps plein/partiel (full/part-time)","Expérience requise (experience required)"],
    [mcq("When scanning a job posting for the required experience, you look for:",["the company address","words like 'expérience requise', 'minimum X ans d'expérience'","the salary","the closing date"],1,"Scan for key phrases! In job postings: 'Expérience requise: 2 ans minimum' / 'Vous possédez au moins 3 ans d'expérience en...' These signal the experience requirement. CLB 4 reading = find specific information efficiently, not read everything!"),
     mcq("In a schedule 'Ouvert du lundi au vendredi de 8h30 à 17h, sauf jours fériés', the office is closed:",["every day","on weekends and public holidays","only on weekends","only on public holidays"],1,"Fermé le weekend (not mentioned = closed) ET les jours fériés (public holidays). 'Sauf' = except. 'Du lundi au vendredi' = weekdays only. In CLB reading, 'sauf' often contains critical exceptions!"),
     wr("List 3 things to look for when reading a job posting",["salaire","expérience","exigences","horaire","lieu de travail","formation","conditions"],"When reading a job posting: 1) Exigences/qualifications requises (required qualifications), 2) Salaire/rémunération (salary), 3) Horaire et type de poste (schedule, full/part-time). These 3 elements tell you quickly if a job is worth applying for!")]),

  mkL("a2-33","A2 Listening: Voicemail Messages",20,"listening",
    "Understand phone messages in French — critical for daily life in Canada! Voicemail strategy: 1) Listen for WHO is calling (name, organization). 2) Listen for WHY (purpose of call). 3) Listen for WHAT action is needed. 4) Listen for callback number, time, reference numbers. Common types: medical appointment reminders, bank/government messages, employer callbacks, school messages. Note: Quebec French phone messages often use 10-digit numbers!",
    ["Bonjour, je suis... de... (I am... from...)","Je vous appelle au sujet de... (calling about...)","Pourriez-vous me rappeler au... (call me back at...)","Mon numéro de dossier est... (file/case number)","Votre rendez-vous est confirmé pour le... (appointment confirmed)","Rappellez-nous avant le... (call us back before...)","En cas d'urgence, composez le... (in case of emergency, dial...)","Appuyez sur le 1 pour... (press 1 for...)"],
    [mcq("In a medical voicemail, the MOST IMPORTANT information to write down:",["the name of the clinic","the date and time of the appointment, and the callback number","the doctor's specialty","the clinic's address"],1,"Date + time of appointment + callback number = top priority! If you miss the appointment or need to reschedule, you need the number. Always have paper and pen ready when listening to medical voicemails in Canada!"),
     mcq("You hear 'Votre rendez-vous est confirmé pour le mardi 15 mars à 14h.' This means:",["You need to call to confirm","Your appointment is cancelled","Your appointment is confirmed for Tuesday March 15 at 2pm","You need to reschedule"],2,"Confirmé = confirmed (no action needed unless you can't make it). 'Le mardi 15 mars à 14h' = Tuesday March 15 at 2pm (14h = 24h time). Write this down and show up! If you can't make it: call back to cancel or reschedule."),
     wr("Write the key info you'd note from a voicemail about an appointment",["la date","l'heure","le nom","le numéro de téléphone","le motif"],"Key info to note: 1) Nom de l'appelant/organisation, 2) Date et heure du rendez-vous, 3) Numéro de rappel, 4) Numéro de dossier si mentionné, 5) Délai pour rappeler. Have this checklist ready for every voicemail!")]),

  mkL("a2-34","A2 Listening: Service Interactions",20,"listening",
    "Understand service conversations in real Canadian contexts — pharmacy, bank, government office, store. Strategy: Focus on the KEY exchange (what's requested, what's the response, what action is required). Common patterns: clerk asks for ID/documentation, explains a procedure, gives instructions, quotes prices or wait times. Practice: listen for numbers (prices, wait times, amounts) and action words (remplir, signer, apporter, revenir).",
    ["Puis-je voir votre... (May I see your...)","Veuillez remplir ce formulaire (please fill out this form)","Il faudra revenir avec... (you'll need to come back with...)","Le délai est de... jours ouvrables (processing time is... business days)","Signez ici, s'il vous plaît","Avez-vous une pièce d'identité? (ID)","Le montant total est de... (total amount is...)","Voici votre reçu (here is your receipt)"],
    [mcq("'Il faudra revenir avec votre passeport' means you:",["don't need your passport","should mail your passport","must come back with your passport","have already submitted your passport"],2,"Il faudra = will be necessary (future of il faut). 'Revenir avec' = come back with. Very common at government offices when you don't have all documents. Note: 'jours ouvrables' = business days (not calendar days — weekends don't count)!"),
     mcq("'Le délai de traitement est de 10 jours ouvrables' means:",["ready in 10 hours","ready in 10 calendar days (including weekends)","ready in 10 business days (weekdays only)","ready in 10 weeks"],2,"Jours ouvrables = business days (Monday-Friday, excluding holidays). 10 jours ouvrables = about 2 weeks. Important distinction when waiting for documents, credit cards, or government decisions in Canada!"),
     wr("Write what you'd say if asked 'Puis-je voir une pièce d'identité?'",["oui, voici mon passeport","voici ma carte de résidence permanente","voici ma carte d'identité","bien sûr, voici..."],"Bien sûr, voici mon passeport / ma carte de résidence permanente. — Always carry your primary ID document in Canada. If you don't have it: 'Je n'ai pas mon passeport sur moi, mais j'ai ma carte de résident permanent.' Always explain what you DO have!")]),

  mkL("a2-35","A2 Writing: Short Opinion Paragraph",25,"writing",
    "Write a structured opinion paragraph — the foundation of all CLB writing tasks! Structure: 1) Topic sentence (state your opinion clearly). 2) Reason 1 + example/explanation. 3) Reason 2 + example/explanation. 4) Conclusion (restate or expand opinion). Target: 60-100 words for CLB 4, 80-120 for CLB 5. Language: À mon avis, selon moi, je pense que + parce que/car + de plus, en outre + c'est pourquoi, par conséquent.",
    ["Phrase d'accroche / opinion initiale","Raison 1 + exemple (parce que / car)","Raison 2 + exemple (de plus / également)","Conclusion (c'est pourquoi / en conclusion)","Connecteurs: parce que, car, de plus, cependant","Longueur: 60-120 mots selon le niveau CLB","Registre: formal (vous, pas d'argot)","Orthographe et ponctuation!"],
    [mcq("The FIRST sentence of an opinion paragraph should:",["start with 'I' in English by mistake","state your position/opinion clearly on the topic","list all your arguments","give your conclusion"],1,"Topic sentence = state your opinion clearly first. 'À mon avis, apprendre le français est essentiel pour les immigrants au Canada.' — Clear position + topic. Everything else supports this opening statement!"),
     mcq("'De plus' in a paragraph means:",["on the contrary","in conclusion","furthermore/additionally","for example"],1,"De plus = furthermore/additionally. Adds a second argument: 'Premièrement... De plus... Enfin...' Connectors show logical organization — key for CLB scoring! Also: également (also), en outre (furthermore), par ailleurs (besides)."),
     wr("Write a topic sentence about learning French in Canada",["à mon avis, apprendre le français","selon moi, le français est","je pense que parler français","il est important d'apprendre le français"],"À mon avis, apprendre le français est indispensable pour s'intégrer pleinement à la vie canadienne. — Indispensable (indispensable) + pour + infinitive = strong, clear CLB 5 topic sentence! Now add 2 reasons and a conclusion to complete your paragraph.")]),

  mkL("a2-36","A2 Writing: Complaint Message",25,"writing",
    "Write a formal complaint — essential for consumer rights in Canada! Structure: 1) Identify yourself + situation. 2) Describe the problem precisely (dates, amounts, reference numbers). 3) State what you want (refund, repair, explanation, apology). 4) Give deadline for response. 5) Mention next steps if unresolved (consumer protection agency = Office de la protection du consommateur in Quebec). Tone: firm but polite, factual.",
    ["Je vous écris pour vous faire part de ma déception concernant... (I write to express my disappointment regarding...)","Le [date], j'ai acheté/commandé... (on [date], I purchased...)","Malgré [X], le problème persiste (despite [X], problem continues)","Je vous demande de me rembourser / réparer / remplacer","Dans un délai de X jours ouvrables","À défaut, je me verrai contraint de contacter... (failing this, I will contact...)","Office de la protection du consommateur (OPC)"],
    [mcq("A formal complaint letter should be:",["angry and threatening","emotional and personal","polite, factual, and specific with dates/amounts","brief and vague"],2,"Always: polite tone + specific facts (dates, amounts, order numbers) + clear request + deadline. Even if you're frustrated, professional tone gets better results. 'Je vous fais part de ma déception' is firm but respectful."),
     mcq("'À défaut, je me verrai contraint de contacter l'Office de la protection du consommateur' means:",["I will never contact the OPC","If this isn't resolved, I will be forced to contact the consumer protection agency","I already contacted the OPC","I recommend contacting the OPC"],1,"À défaut = failing this / if not resolved. Je me verrai contraint de = I will be forced to. This phrase escalates the complaint professionally — it shows you know your rights without being aggressive. Very effective in Canada!"),
     wr("Write the first sentence of a complaint about a defective product",["je vous écris pour vous faire part","je vous contacte au sujet d'un problème","je souhaite vous signaler un défaut","suite à mon achat"],"Je vous écris pour vous faire part d'un problème concernant un produit acheté le [date] dans votre magasin (référence: [number]). — Perfect opening: polite, explains purpose, includes date and reference number. Everything needed for a clear CLB 5 complaint!")]),

  mkL("a2-37","A2 Speaking: Routine & Daily Life",20,"speaking",
    "Describe your daily life fluently — a core CLB 4 speaking task! Full-day routine: le matin (morning: se lever, se préparer, prendre le petit-déjeuner, aller au travail/école), la journée (during the day: travailler, manger, prendre des pauses), le soir (evening: rentrer, préparer le dîner, se reposer, regarder la télé, se coucher). Use time markers and sequence connectors. Add details: commute time, workplace/school, responsibilities.",
    ["D'abord / En premier (first of all)","Ensuite / Puis (then/next)","Vers [heure] (around [time])","À [heure] précise (at exactly [time])","Je prends [X] minutes pour (it takes me X min to)","Le soir, je rentre vers... (I get home around...)","Je me couche généralement à... (I usually go to bed at...)","Le weekend, je..."],
    [mcq("'Je prends le bus jusqu'au travail, ça prend environ 45 minutes.' This sentence describes:",["a one-time event","your daily commute routine","a future plan","a past experience"],1,"Daily routine = present tense + frequency words. 'Je prends le bus' (present habit) + 'ça prend environ' (it takes about — expressing duration). Perfect for describing your regular commute!"),
     mcq("Which sequence best describes a morning routine?",["D'abord je me couche, ensuite je déjeune, puis je me réveille","D'abord je me réveille, puis je me lève, ensuite je prends mon petit-déjeuner","Je me couche d'abord, ensuite je m'habille, puis je me réveille","Je déjeune, puis je me réveille, d'abord je m'habille"],1,"Logical sequence: réveil → lever → douche/habillage → petit-déjeuner → départ. D'abord > puis > ensuite > après > finalement. Sequence connectors make your routine description sound organized and fluent!"),
     wr("Describe your morning in 3 sentences",["d'abord","puis","ensuite","je me lève","je prends","je pars"],"D'abord, je me lève à 6h30 et je prends une douche rapide. Ensuite, je prépare mon café et je mange. Puis, je prends le bus pour aller au travail — ça prend environ 30 minutes. — 3 well-connected sentences = CLB 4 speaking score!")]),

  mkL("a2-38","A2 Speaking: Work & Employment",25,"speaking",
    "Talk about work and employment in French — vital for professional integration! Describe your job: Je travaille comme/en tant que... (I work as...), Mes responsabilités incluent... (My responsibilities include...), Je travaille à temps plein/partiel (full/part-time), Je suis en contrat/permanent (on contract/permanent). Job searching: Je cherche un emploi dans... (looking for work in...), J'ai postulé pour... (I applied for...), un CV, une lettre de motivation, un entretien d'embauche (job interview).",
    ["Je travaille comme / en tant que...","Mes responsabilités: je suis responsable de...","à temps plein/partiel (full/part-time)","Je suis en contrat / permanent(e) (contract/permanent)","Je cherche un emploi dans le domaine de...","Postuler pour un poste (apply for a position)","Le CV et la lettre de motivation","Un entretien d'embauche (job interview)","Le salaire brut/net (gross/net salary)","Les avantages sociaux (employee benefits)"],
    [mcq("'Je travaille en tant qu'infirmière à temps partiel' means:",["I want to be a part-time nurse","I work as a part-time nurse","I worked as a full-time nurse","I was a nurse"],1,"En tant que = as (in a professional capacity). 'Je travaille en tant qu'infirmière à temps partiel dans un CHSLD' = I work as a part-time nurse in a long-term care facility. More formal than 'je suis infirmière' in professional contexts!"),
     mcq("'Les avantages sociaux' in a job offer refers to:",["social media perks","employee benefits (health, dental, pension)","social work responsibilities","vacation pay only"],1,"Avantages sociaux = employee benefits package: assurance collective (group insurance), assurance dentaire (dental), régime de retraite (pension plan), congés payés (paid vacation). Always check these when comparing job offers in Canada!"),
     wr("Describe your work experience in 2 sentences",["j'ai travaillé","je travaille","mes responsabilités","j'ai de l'expérience","en tant que"],"J'ai travaillé pendant 5 ans comme comptable dans mon pays d'origine. Actuellement, je cherche un emploi dans le domaine de la finance au Canada, où mes compétences pourraient être utiles. — Excellent CLB 5 employment description!")]),

  mkL("a2-39","A2 Integrated Practice",30,"integrated",
    "Full A2 integrated practice — combining all 4 skills in one realistic scenario. Scenario: You are a newcomer who just received a lease for an apartment. You need to: understand the lease terms (reading), ask the landlord questions (speaking), write a confirmation email (writing), and understand the landlord's voicemail response (listening). This mirrors real CLB 4-5 test format!",
    ["Lecture du bail (reading a lease)","Vocabulaire: loyer, charges, durée, résiliation","Questions au propriétaire (speaking)","Courriel de confirmation (writing: formal, vous)","Comprendre une réponse téléphonique (listening)","Vocabulaire intégré: logement, argent, rendez-vous"],
    [mcq("In a lease, 'reconduction automatique' means:",["the lease is automatically cancelled","the lease automatically renews unless proper notice is given","rent automatically increases","the landlord can automatically evict you"],1,"Reconduction automatique = automatic renewal. If you don't give proper written notice (avis de non-renouvellement) before the deadline, your lease automatically renews for another year in Quebec! Critical tenant knowledge!"),
     mcq("The CORRECT email opening to a new landlord (you haven't met in person):",["Salut [name]!","Allo,","Bonjour Monsieur/Madame [Name],","Hey,"],2,"Bonjour Monsieur/Madame [Name], — always formal with a new landlord. You'll switch to first name once they invite you to, but start formal. If you don't know their name: 'Bonjour Madame, Bonjour Monsieur,' (both included)."),
     wr("Write the body of a confirmation email for signing a lease",["je vous confirme","je suis disponible","je souhaite confirmer","suite à notre conversation","je suis heureux de confirmer"],"Suite à notre conversation téléphonique, je vous confirme ma disponibilité pour la signature du bail le [date] à [heure]. Je me présenterai avec les documents requis (pièce d'identité, preuve d'emploi). Merci de votre confiance. — Professional, complete, confirms details!")]),

  mkL("a2-40","A2 Final Assessment",30,"integrated",
    "A2 COMPLETE! Final comprehensive assessment covering all A2 grammar and vocabulary. You should be able to: narrate past events using PC and imparfait, talk about future plans, express opinions with justification, write formal emails and letters, understand service conversations, read notices and documents. If you can do all this, you're at CLB 4 performance — ready for B1! Félicitations — c'est une étape majeure!",
    ["Bilan A2: passé composé, imparfait, futur, conditionnel","Pronoms: directs, indirects, y, en, relatifs","Compréhension: annonces, messages, courriels","Production: email formel, paragraphe d'opinion","Interaction: services, travail, logement","Vous êtes au niveau CLB 4 — bravo!"],
    [mcq("'Si j'avais su, je n'aurais pas signé ce bail.' This sentence expresses:",["a future plan","a present habit","a past regret (conditional perfect + pluperfect)","a description of the past"],2,"Si + plus-que-parfait (j'avais su) + conditionnel passé (je n'aurais pas signé) = Type 3 conditional — expressing regret about the PAST. 'If I had known, I wouldn't have signed that lease.' This structure shows advanced A2/B1 level!"),
     mcq("The CORRECT sentence is:",["Je suis allé à la pharmacie hier et j'ai achetais des médicaments","Hier, je suis allé à la pharmacie et j'ai acheté des médicaments","Je allais à la pharmacie et j'ai acheté des médicaments","Hier, j'ai allé à la pharmacie et j'achetais des médicaments"],1,"Je suis allé (être verb = aller) + j'ai acheté (avoir verb = acheter) — both passé composé for specific past events. The others mix up tenses or use wrong auxiliary!"),
     wr("Write 3 sentences showing your A2 level: past, future, and opinion",["j'ai","je vais","à mon avis","je voudrais","selon moi","je pense que"],"J'ai commencé à apprendre le français il y a un an. L'année prochaine, je passerai le TEF Canada. À mon avis, parler français ouvre beaucoup de portes au Canada. — Three tenses + opinion = A2 showcase! Félicitations — vous passez maintenant au niveau B1!")])
];


// ─────────────────────────────────────────────────────────────────────────────
// B1 — 40 LESSONS
// ─────────────────────────────────────────────────────────────────────────────
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
    [mcq("'Il faut que vous ___ ce formulaire.' (remplir — to fill out)",["remplissez","remplissiez","remplissez","remplirez"],1,"Remplissiez = subjonctif of remplir for vous. Formation: ils remplissent → rempliss → vous remplissiez. 'Il faut que' ALWAYS triggers subjunctive! 'Il faut que vous remplissiez ce formulaire' = You must fill out this form."),
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
    [mcq("The concession in a speaking monologue shows:",["you've run out of arguments","you lack confidence in your position","critical thinking and awareness of other perspectives","you agree with the opposing view"],2,"Concession = intellectual maturity. 'Certes, il est vrai que certains estiment que X. Cependant, à mon avis...' Acknowledging the other side then returning to your position = sophisticated argumentation. CLB 6 assessors look for this!"),
     mcq("For a 2-minute monologue, each section should be approximately:",["all 2 minutes on one point","15-30 seconds each for 5-6 sections","1 minute introduction only","2 minutes on conclusion only"],1,"5-6 sections of 15-30 seconds each = 2 minutes. Time yourself! Practice with a timer. If you run short, expand your examples. If you run long, tighten your transitions. Rhythm and timing are part of CLB 6 speaking assessment!"),
     wr("Write a 3-sentence introduction for: 'Faut-il rendre le français obligatoire au travail au Québec?'",["à mon avis","selon moi","l'utilisation du français","je pense que","cette question","le français au travail"],"La question de l'obligation du français au travail au Québec est au cœur des débats sur l'identité culturelle et l'intégration économique. À mon avis, renforcer l'usage du français dans les milieux professionnels est non seulement justifié, mais nécessaire pour préserver la vitalité de la langue française. Dans les deux prochaines minutes, j'exposerai les raisons de cette conviction. — Perfect CLB 6 introduction!")]),

  mkL("b1-20","Speaking: Debate & Discussion",25,"speaking",
    "Participate in French debates and discussions — CLB 6 interactive speaking! Agreeing: Je suis d'accord avec vous parce que..., Tout à fait!, Vous avez raison, c'est vrai que... Disagreeing politely: Je ne partage pas tout à fait votre avis..., Je comprends votre point de vue, mais..., Permettez-moi de nuancer... Taking the floor: Si je peux me permettre..., J'aimerais ajouter que..., Pour rebondir sur ce que vous avez dit... Asking for clarification: Pourriez-vous préciser ce que vous entendez par...?",
    ["Je suis (tout à fait) d'accord (I fully agree)","Je ne partage pas votre avis (I don't share your view)","Je comprends votre point de vue, mais... (I understand but...)","Permettez-moi de nuancer (allow me to nuance)","Si je peux me permettre... (if I may...)","J'aimerais rebondir sur ce point (I'd like to build on this)","Pourriez-vous préciser? (Could you clarify?)","En d'autres termes,... (in other words)"],
    [mcq("'Je ne partage pas tout à fait votre avis' is:",["a polite way to strongly disagree","an agreement","a request for clarification","a conclusion"],0,"'Je ne partage pas tout à fait votre avis' = I don't quite share your view. 'Tout à fait' (completely/quite) actually softens it — it's not a TOTAL disagreement. Very polite way to disagree in French. Always follow with 'parce que...' or 'car je pense que...'"),
     mcq("'Pour rebondir sur ce que vous avez dit...' means:",["To return to what was said before","To build on / respond to what you said","To disagree completely with what you said","To repeat what you said"],1,"Rebondir sur = to bounce off / to build on. 'Pour rebondir sur ce point' = to pick up on that point. Used to connect your contribution to the previous speaker — shows active listening and debate skills. Very CLB 6!"),
     wr("Politely disagree with: 'Le français n'est pas important pour trouver du travail au Canada.'",["je ne partage pas votre avis","je comprends votre point de vue, mais","permettez-moi de nuancer","je suis en désaccord, car"],"Je comprends votre point de vue, mais je ne partage pas tout à fait cet avis. En effet, dans de nombreux secteurs au Canada, notamment au Québec, la maîtrise du français est un critère de sélection déterminant. — Polite, structured disagreement with evidence. CLB 6 debate skill!")]),

  mkL("b1-21","Speaking: Job Interview in French",30,"speaking",
    "Ace a French job interview! Preparation: research the company (rechercher l'entreprise), prepare for common questions. Common questions: Parlez-moi de vous (Tell me about yourself — 90 sec!), Quelles sont vos forces/faiblesses? (strengths/weaknesses?), Pourquoi voulez-vous travailler chez nous? (Why this company?), Où vous voyez-vous dans 5 ans? (Where do you see yourself in 5 years?), Avez-vous des questions? (Do you have questions?). Always: formal, confident, specific examples using STAR method.",
    ["Parlez-moi de vous (Tell me about yourself)","Mes points forts sont... (my strengths are)","Un axe d'amélioration pour moi est... (area for improvement)","Pourquoi ce poste? (Why this position?)","J'ai de l'expérience dans... (I have experience in)","La méthode STAR: Situation, Tâche, Action, Résultat","Avez-vous des questions pour nous? (Do you have questions?)","Merci pour cette opportunité (Thank you for this opportunity)"],
    [mcq("'Parlez-moi de vous' should be answered in approximately:",["30 seconds","1-2 minutes (structured: background, experience, goals)","5 minutes","10 minutes"],1,"1-2 minutes = ideal. Structure: 1) Brief background (30 sec), 2) Relevant experience (45 sec), 3) Why this role (30 sec). NOT your life story — focused on professional relevance. Practice until smooth and natural!"),
     mcq("When asked about a weakness, the best approach is:",["Say you have no weaknesses","Invent a fake strength disguised as weakness","Mention a real weakness + what you're doing to improve it","Refuse to answer"],2,"Real weakness + active improvement = authentic and impressive. 'Un axe d'amélioration pour moi est la gestion du temps. J'ai commencé à utiliser des outils de planification et cela s'améliore progressivement.' Shows self-awareness AND initiative!"),
     wr("Describe your strongest professional quality in French",["mon point fort est","ma principale qualité est","je suis particulièrement","j'excelle dans"],"Mon point fort est ma capacité à m'adapter rapidement à de nouveaux environnements. Par exemple, lors de mon arrivée au Canada, j'ai appris le français tout en occupant un emploi à temps partiel. — Strength + concrete example from your Canadian experience = excellent interview answer!")]),

  mkL("b1-22","Listening: Extended Conversation",25,"listening",
    "Understand extended conversations at B1/CLB 5 level! Strategies: 1) Listen for topic changes (alors, maintenant, d'ailleurs, à propos de). 2) Identify speaker positions (agreement/disagreement markers). 3) Note opinions vs facts (je pense que = opinion, des études montrent que = fact). 4) Listen for examples (par exemple, c'est le cas de, notamment). Common conversation types: service calls, workplace discussions, family decisions, news interviews, community meetings.",
    ["Repérer les changements de sujet (topic shifts)","Distinguer opinion vs fait (je pense vs des études montrent)","Connecteurs de discussion: d'ailleurs, à propos, en plus","Accord/désaccord: exactement, c'est vrai, mais/cependant","Exemples: par exemple, notamment, c'est le cas de","Résumer ce qu'on a compris (summarize)","Poser des questions de clarification","CLB 5 listening: 3-5 min dialogue"],
    [mcq("In a discussion, 'D'ailleurs' signals:",["a strong disagreement","a contradiction","an additional related point (besides/moreover)","a question"],2,"D'ailleurs = besides/moreover/incidentally. It introduces an additional related point. 'Le français est important. D'ailleurs, au Québec, c'est la seule langue officielle.' Common in natural French conversation — signals fluency when you use it!"),
     mcq("'Des études montrent que...' introduces:",["an opinion","a fact or research finding","a personal example","a question"],1,"Des études montrent que = studies show that = fact/research finding. Distinguishing facts from opinions is a key CLB 5 listening skill. Compare: 'Je pense que...' (opinion) vs 'Selon une étude de...' (fact). Always note which is which when listening!"),
     wr("Write 3 signal phrases that introduce a new topic in conversation",["à propos de","en ce qui concerne","d'ailleurs","parlant de","pour ce qui est de","maintenant, parlons de"],"À propos de... / En ce qui concerne... / D'ailleurs,... — Three topic-shift signals used in natural French conversation. Using these appropriately in your own speech signals B1+ competency and makes conversations flow naturally!")]),

  mkL("b1-23","Listening: Radio & News Segment",25,"listening",
    "Understand French radio and news at CLB 5-6 level! Radio-Canada, ICI Radio-Canada Première, RDI, TVA Nouvelles — all essential sources. Strategies for news: 1) First sentences contain the ESSENTIAL information (who, what, when, where). 2) Numbers and proper nouns = priority listening. 3) Quotes from sources (selon le ministre, d'après les experts). 4) Story structure: fact → context → reaction → outlook. Quebec-specific: Journal de Montréal, Le Devoir, La Presse.",
    ["Radio-Canada / ICI Radio-Canada (public broadcaster)","RDI (Radio-Canada info channel)","Les nouvelles du jour (today's news)","Selon le/la ministre... (according to the minister)","D'après les experts (according to experts)","On apprend que... (we learn that)","Il ressort que... (it emerges that)","Le [date], [who] a [what] à [where]","Suite à (following/as a result of)"],
    [mcq("In a news segment, the most important information is usually:",["the last sentence","the reporter's opinion","in the first 1-2 sentences (headline facts)","in the middle of the report"],2,"Lead first! News writing puts the essential W5 (who, what, when, where, why) in the opening sentences. Strategies: listen intensely to the first 20 seconds, then use context for the rest. Even if you miss words, the opening gives you the main story!"),
     mcq("'Selon les autorités sanitaires' means:",["according to the health authorities","against the health authorities","despite the health authorities","for the health authorities"],0,"Selon = according to. 'Selon les autorités sanitaires' = according to health authorities. News frequently cites sources: selon le gouvernement, d'après les experts, selon une étude, d'après le rapport. Identifying sources = CLB 5 listening skill!"),
     wr("Write a 1-sentence news headline about a fictional health initiative",["le gouvernement annonce","une nouvelle mesure","selon le ministre","les autorités de santé","la province de québec"],"Le gouvernement québécois annonce un nouveau programme de vaccination contre la grippe pour les personnes de plus de 65 ans, selon le ministère de la Santé. — Perfect news headline structure: who (government) + what (program) + for whom + source!")]),

  mkL("b1-24","Reading: News Article",25,"reading",
    "Read French newspaper articles at CLB 5-6 level! Quebec newspapers: La Presse, Le Devoir, Journal de Montréal (tabloid), Le Soleil (Quebec City). Structure of news articles: titre (headline), chapeau/sous-titre (lead paragraph — most important), corps (body — supporting details, context, quotes), conclusion. Reading strategies: read title + first paragraph = understand 70% of article. Scan for: numbers, dates, names, and opinion vs fact markers.",
    ["Le titre (headline)","Le chapeau/sous-titre (lead — most important!)","Le corps de l'article (body)","Selon [source] vs 'Il est établi que' (opinion vs fact)","Repérer les chiffres et les noms propres","Inférence contextuelle (guessing from context)","Expressions journalistiques: on apprend que, il ressort, suite à","Citation directe: 'Nous devons agir,' a déclaré..."],
    [mcq("'Le chapeau' of a newspaper article contains:",["the journalist's opinion","the most important facts (W5: who, what, when, where, why)","background and history","expert quotes only"],1,"Le chapeau (lead/intro paragraph) = the most critical part! It answers: qui, quoi, quand, où, pourquoi. If you only read the title + chapeau, you understand the essential news. This is key for CLB 5 reading efficiency!"),
     mcq("'A déclaré le premier ministre' in an article means:",["according to the prime minister","the prime minister declared (direct quote)","it is said by the prime minister","the prime minister was declared"],1,"A déclaré = declared/stated (past, direct quote attribution). 'Nous devons agir immédiatement,' a déclaré le premier ministre. This structure introduces direct quotes in French journalism. Also: a affirmé, a ajouté, a précisé, a souligné."),
     wr("Summarize a 3-sentence article about Quebec French language laws",["la loi","le français","les entreprises doivent","selon le gouvernement","la charte de la langue française"],"Selon un récent article, le gouvernement québécois a renforcé la Charte de la langue française (Loi 101) pour exiger que les entreprises de plus de 25 employés fonctionnent en français. Cette mesure vise à protéger et promouvoir le statut du français au Québec. — Article summary in CLB 5 French!")]),

  mkL("b1-25","Reading: Official Canadian Document",25,"reading",
    "Read official Canadian documents — immigration letters, tax notices, employment contracts, government forms! Key vocabulary: attendu que (whereas), conformément à (in accordance with), en vertu de (by virtue of/under), sous réserve de (subject to), à titre de (as/in the capacity of), ci-dessus/ci-dessous (above/below mentioned), susmentionné (aforementioned), ledit/ladite (the said), le cas échéant (if applicable), s'il y a lieu (where applicable).",
    ["conformément à (in accordance with)","en vertu de (by virtue of/under)","sous réserve de (subject to)","attendu que (whereas — preamble language)","ci-dessus/ci-dessous (above/below mentioned)","le présent document (this document)","à compter du [date] (effective/starting [date])","le cas échéant (if applicable)","veuillez noter que (please note that)","toute fausse déclaration (any false declaration)"],
    [mcq("'Conformément à l'article 15 de la loi' means:",["contrary to article 15","approximately per article 15","in accordance with article 15 of the law","before article 15 of the law"],2,"Conformément à = in accordance with. Very common in legal and official documents. 'Conformément à la loi sur la protection des renseignements personnels, vos données sont protégées.' You'll see this on every Canadian privacy notice!"),
     mcq("'Sous réserve de l'approbation finale' means:",["after final approval","subject to final approval","without final approval","despite final approval"],1,"Sous réserve de = subject to / conditional upon. 'Sous réserve de l'approbation finale du comité, votre demande sera acceptée' = Subject to final committee approval, your request will be accepted. Common in contracts, job offers, and government decisions!"),
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
     mcq("The best strategy for CLB listening is to:",["translate every word into your language","listen only once and try to remember everything","read questions first, take notes during, check immediately after","only focus on words you know"],2,"Read questions FIRST → know what you're listening for. Take notes during → capture key info. Review immediately → fill in gaps with context. This active listening strategy works for CLB 4, 5, 6, and 7 tests!"),
     wr("Write 3 things you'll listen for in a CLB listening passage about an apartment",["le loyer","le nombre de chambres","la localisation","les charges","la disponibilité","les conditions"],"Les 3 éléments clés: 1) Le loyer mensuel (rent amount), 2) Les caractéristiques (nombre de chambres, inclus ou non), 3) La disponibilité et les conditions (when available, requirements). Reading the question about apartments first tells you to listen for these specific details!")]),

  mkL("b1-31","CLB 5 Reading Practice",25,"reading",
    "CLB 5 reading includes: reading for specific information (scanning), reading for general understanding (skimming), reading to infer (reading between the lines). Text types: notices, short articles, emails, advertisements, schedules. Strategies: 1) Skim the whole text first (30 sec). 2) Read questions. 3) Return to text for specific answers. 4) For inference questions: use context + logic, not stated directly. Key CLB 5 vocabulary in texts: municipal notices, workplace emails, school communications, health instructions.",
    ["Survol (skimming) = vue générale rapide","Lecture sélective (scanning) = trouver info spécifique","Inférence = lire entre les lignes","Vocabulaire: avis, règlement, politique, conformément","Type de texte détermine la stratégie","Questions d'inférence: 'on peut en déduire que'","Questions factuelles: retourner au texte précisément","Temps de lecture: gérer efficacement"],
    [mcq("'On peut en déduire que...' in a CLB reading question means:",["find the exact quote from the text","infer from the text (not directly stated)","calculate a number from the text","find the opinion of the author"],1,"'On peut en déduire que' = inference question! The answer is NOT directly stated — you must use logic and context. 'The text doesn't say this directly, but based on the information given, we can logically conclude that...' These are the hardest CLB reading questions!"),
     mcq("For a scanning task, the most efficient approach is:",["read every word carefully from start to finish","skim the whole text first, then find the specific information","only read the first paragraph","read the last paragraph first"],1,"Skim first (understand topic + structure), then scan for the specific word/number/name you need. Don't read everything carefully — that wastes time in timed CLB reading tests!"),
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
    // Append success redirect param to payment link
    const link=STRIPE_PAYMENT_LINK.includes("?")
      ? STRIPE_PAYMENT_LINK+"&client_reference_id=franco&success_url="+encodeURIComponent(window.location.href+"?success=1")
      : STRIPE_PAYMENT_LINK;
    window.open(link,"_blank");
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
          🚀 Start Premium — {PRICE_DISPLAY}
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
  const [mode,setMode] = useState("chat"); // chat | assessment | plan
  const bottomRef = useRef();
  const authCtx = useAuth();

  // Build rich context about the learner
  const learnerContext = `
You are ${c.name}, a personal French tutor for Canadian immigrants learning French for CLB/TEF exams.

LEARNER PROFILE:
- Current level: ${level.label} (${level.cefrTag}, ${level.clbTag})
- Lessons completed: ${done.length}/${allL.length}
- Skills completed: Listening ${allL.filter(l=>l.skill==="listening"&&progress[l.id]).length}/${allL.filter(l=>l.skill==="listening").length}, Speaking ${allL.filter(l=>l.skill==="speaking"&&progress[l.id]).length}/${allL.filter(l=>l.skill==="speaking").length}, Writing ${allL.filter(l=>l.skill==="writing"&&progress[l.id]).length}/${allL.filter(l=>l.skill==="writing").length}, Reading ${allL.filter(l=>l.skill==="reading"&&progress[l.id]).length}/${allL.filter(l=>l.skill==="reading").length}
- Next lesson: ${notDone[0]?.title||"All complete!"}
- Recent lessons: ${done.slice(-3).map(l=>l.title).join(", ")||"None yet"}

YOUR ROLE:
- Be their dedicated personal tutor, not just a chatbot
- Give specific, actionable advice based on their actual progress
- Correct French mistakes immediately and kindly
- Reference their specific completed lessons when relevant
- Help them prepare for CLB 5 specifically
- Be warm, encouraging, and Canadian-context focused
- Mix French practice INTO the conversation naturally
- Remember: they are immigrants who NEED this for their life in Canada

TUTORING MODES:
- General chat: answer questions, practice conversation, explain grammar
- Assessment: quiz them on weak areas based on their progress
- Study plan: create a personalized daily study plan

Always respond in a mix of English and French appropriate to their level.
Keep responses focused and practical — max 4-5 sentences unless explaining something complex.`;

  const sendMessage = async(text) => {
    if(!text.trim()||loading) return;
    const userMsg = {role:"user", text};
    const newMsgs = [...msgs, userMsg];
    setMsgs(newMsgs);
    setInput("");
    setLoading(true);
    const history = newMsgs.slice(-8).map(m=>`${m.role==="user"?"Learner":"Tutor"}: ${m.text}`).join("");
    const reply = await callClaude(learnerContext, `${history}

Learner: ${text}

Tutor:`, 400);
    setMsgs(m=>[...m,{role:"assistant",text:reply}]);
    setLoading(false);
    setTimeout(()=>bottomRef.current?.scrollIntoView({behavior:"smooth"}),100);
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
    // Auto-greeting based on progress
    const greet = async()=>{
      setLoading(true);
      const prompt = done.length===0
        ? `Greet this new learner warmly. They haven't started yet. Introduce yourself as their personal tutor and ask what brings them to learn French in Canada. Be warm and encouraging.`
        : `Greet this returning learner. They've completed ${done.length} lessons. Reference their progress briefly, note their next lesson is "${notDone[0]?.title||"all done!"}", and ask how their French is going or what they want to work on today. Keep it short and personal.`;
      const reply = await callClaude(learnerContext, prompt, 200);
      setMsgs([{role:"assistant",text:reply}]);
      setLoading(false);
    };
    greet();
  },[]);

  return <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 64px)",maxWidth:800,margin:"0 auto"}}>
    {/* Header */}
    <div style={{padding:"14px 20px",background:"#fff",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:12}}>
      <Avatar companion={c} size={40} speaking={loading}/>
      <div style={{flex:1}}>
        <div style={{fontWeight:700,fontSize:15,color:T.navy}}>{c.name} — Your Personal Tutor</div>
        <div style={{fontSize:11,color:T.mint,fontWeight:600}}>● Personalized for your CLB journey · {done.length} lessons tracked</div>
      </div>
      <div style={{display:"flex",gap:6}}>
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
      {msgs.map((m,i)=>(
        <div key={i} style={{display:"flex",gap:10,marginBottom:16,flexDirection:m.role==="user"?"row-reverse":"row",alignItems:"flex-start"}}>
          {m.role==="assistant"&&<Avatar companion={c} size={36}/>}
          <div style={{maxWidth:"78%",background:m.role==="user"?`linear-gradient(135deg,${T.blue},${T.navy})`:"#fff",color:m.role==="user"?"#fff":T.text,padding:"12px 16px",borderRadius:m.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px",fontSize:14,lineHeight:1.7,border:m.role==="assistant"?`1.5px solid ${T.border}`:"none",boxShadow:"0 2px 8px rgba(0,0,0,0.05)"}}>
            {m.text}
          </div>
        </div>
      ))}
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
        else{window.open("https://buy.stripe.com/7sY6oIaaYfe6c0K6Di2go00","_blank");}
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

export default function App(){
  return <AuthProvider><AppInner/></AuthProvider>;
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
