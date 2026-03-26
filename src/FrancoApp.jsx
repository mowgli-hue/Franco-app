import { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } from "react";
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, signOut, reload, updateProfile } from "firebase/auth";


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
if(hasFirebaseConfig){
  try{
    _firebaseApp = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
    _firebaseAuth = getAuth(_firebaseApp);
  }catch(e){ console.error("[firebase] init failed",e); }
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
  const[user,setUser]=useState(undefined); // undefined = still initializing
  const[initializing,setInitializing]=useState(true);

  useEffect(()=>{
    if(!_firebaseAuth){ setInitializing(false); return; }
    const unsub = onAuthStateChanged(_firebaseAuth, u=>{ setUser(u); setInitializing(false); });
    return unsub;
  },[]);

  const value = useMemo(()=>({
    user,
    initializing,
    firebaseReady: !!_firebaseAuth,

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
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:30,fontWeight:900,color:"#0B1220",lineHeight:1.2,marginTop:8}}>French Training for Canada</div>
        <div style={{fontSize:15,color:"#475569",lineHeight:1.65}}>Structured daily sessions to improve CLB performance for immigration goals.</div>

        {/* CTA buttons */}
        <button onClick={()=>onNavigate("login")}
          style={{marginTop:16,width:"100%",maxWidth:340,padding:"15px 32px",background:"#1A56DB",color:"#fff",border:"none",borderRadius:14,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:16,cursor:"pointer",boxShadow:"0 4px 20px rgba(26,86,219,0.3)",transition:"all 0.2s"}}
          onMouseEnter={e=>e.currentTarget.style.background="#1547c0"}
          onMouseLeave={e=>e.currentTarget.style.background="#1A56DB"}>
          Start Training
        </button>

        <button onClick={onGuest}
          style={{marginTop:8,padding:"11px 28px",background:"#EFF6FF",color:"#1A56DB",border:"1.5px solid #BFDBFE",borderRadius:999,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",transition:"all 0.2s"}}
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
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:26,fontWeight:700,color:"#0D1B3E"}}>Welcome back</div>
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
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:26,fontWeight:700,color:"#0D1B3E"}}>Create your account</div>
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
          style={{width:"100%",padding:"12px 14px",paddingRight:isPass?44:14,borderRadius:10,border:`1.5px solid ${error?"#EF4444":"#E2E8F0"}`,fontFamily:"'DM Sans',sans-serif",fontSize:14,color:"#0D1B3E",outline:"none",background:"#fff",boxSizing:"border-box",transition:"border-color 0.2s"}}
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
      style={{padding:"12px 20px",borderRadius:12,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:disabled||loading?"not-allowed":"pointer",opacity:disabled&&!loading?0.6:1,transition:"all 0.2s",...styles}}>
      {loading?"Loading...":label}
    </button>
  );
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
  navy:"#0D1B3E",blue:"#1A56DB",blueMid:"#3B82F6",blueLight:"#DBEAFE",
  mint:"#10B981",mintLight:"#D1FAE5",red:"#EF4444",redLight:"#FEE2E2",
  gold:"#F59E0B",goldLight:"#FEF3C7",purple:"#8B5CF6",purpleLight:"#EDE9FE",
  surface:"#F0F4FF",card:"#FFFFFF",text:"#0D1B3E",textMid:"#475569",textSoft:"#94A3B8",border:"#E2E8F0",
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
  mkL("f-01","The French Alphabet",15,"listening",
    "French has 26 letters like English but pronounced very differently! Key differences: E='uh', I='ee', U='oo' (lips rounded), R is guttural (throat). The letter H is always silent. Learning correct pronunciation NOW makes everything easier later.",
    ["A (ah)","E (uh)","I (ee)","O (oh)","U (oo — round lips)","R (guttural, throat)","H (always silent)","accent aigu é","accent grave è","accent circumflex ê"],
    [mcq("How is the French letter 'E' pronounced?",["ee (like 'me')","ay (like 'say')","uh (like 'the')","oh (like 'go')"],2,"French 'E' = 'uh' — the neutral schwa sound. Very different from English! Hear it in: le, me, te, ce."),
     mcq("The French 'U' sound is made by:",["saying 'oo' with relaxed lips","rounding lips as if saying 'oo' but saying 'ee'","saying 'you'","saying 'uh'"],1,"French U is unique! Round your lips for 'oo' but say 'ee'. Try: lune, rue, vu. This sound doesn't exist in English!"),
     mcq("Which letter is ALWAYS silent in French?",["R","S","H","L"],2,"H is always silent: hôpital = 'opital', homme = 'omm', heure = 'eur'. Never pronounce H in French — ever!"),
     wr("Write the French word for 'yes'",["oui"],"Oui (pronounced 'wee') — your very first French word! You'll use this dozens of times every day in Canada.")]),

  mkL("f-02","Nasal Vowels",20,"listening",
    "French has 4 nasal vowels where air passes through your nose — they don't exist in English! ON (bonjour, bon, son), AN/EN (France, enfant, dans), IN/AIN (pain, vin, main), UN (brun, lundi). Practice each one: say the vowel while humming through your nose.",
    ["on → bon, son, mon","an/en → France, enfant, dans","in/ain → pain, vin, main","un → brun, lundi","nasal = nose resonance"],
    [mcq("'Bonjour' contains which nasal?",["AN","IN","ON","UN"],2,"ON nasal — the most common! Feel the resonance in your nose. All these words use ON: bon, son, mon, ton, long, pont."),
     mcq("The word 'pain' (bread) uses which nasal?",["ON","AN","IN/AIN","UN"],2,"IN/AIN nasal — sounds like 'an' in English 'and' but nasalized. Other IN words: vin (wine), main (hand), matin (morning)."),
     mcq("'Enfant' (child) contains which nasal?",["ON","AN/EN","IN","UN"],1,"AN/EN nasal — sounds like 'awn'. Very frequent: France, dans, grand, temps, enfant, comment."),
     wr("Write the French word for 'good' (masculine)",["bon"],"Bon — your first nasal word! The ON sound: open mouth slightly, air through nose. Used in: Bonjour, Bonne nuit, Bon appétit!")]),

  mkL("f-03","Accents & Special Characters",15,"reading",
    "French uses 5 accents that change pronunciation and meaning! Accent aigu (é) = 'ay' sound: étudiant, café. Accent grave (è) = open 'eh': père, mère. Accent circumflex (ê) = often 'eh': être, fête. Cédille (ç) = 's' sound before a/o/u: français, garçon. Tréma (ë/ï) = pronounce both vowels: Noël, naïf.",
    ["é (aigu) = ay sound","è (grave) = open eh","ê (circumflex) = eh/ay","ç (cédille) = s sound","ë/ï (tréma) = separate vowels","à/où (grave on a/u = meaning only)"],
    [mcq("The accent in 'café' (é) makes the E sound like:",["uh","ay","oh","ee"],1,"Accent aigu (é) = 'ay' sound! café = 'kafay'. Other é words: étudiant, préféré, répéter, médecin. Very common!"),
     mcq("'Français' has a ç because:",["it's decorative","ç makes the C sound like 'S' before A","ç makes the C sound like 'K'","it's always used before ç"],1,"Cédille (ç) = the C makes an 'S' sound before a, o, u. Without ç: 'francais' would be pronounced 'frankay'. With ç: 'fransay' ✓"),
     mcq("'À' (with accent grave) vs 'a' (no accent) — what's the difference?",["pronunciation only","meaning only — à=to/at, a=has","both pronunciation and meaning","no difference"],1,"'À' = to/at (preposition): Je vais à Montréal. 'A' = has (verb avoir): Il a un rendez-vous. The accent distinguishes meaning, not sound!"),
     wr("Write the French word for 'French' (the language/adjective)",["français","le français"],"Français — with the ç! Without it: 'francais' would sound wrong. In Canada, 'Je parle français' is one of the most important sentences you'll ever say!")]),

  mkL("f-04","Liaison & Silent Letters",15,"listening",
    "Most final consonants in French are SILENT: vous='voo', est='ay', Paris='pah-REE'. BUT when the next word starts with a vowel, silent consonants can come back — this is LIAISON! Vous êtes → 'vouz-êtes', les amis → 'layz-amee', ils ont → 'eelz-on'. Liaison makes French sound smooth and musical.",
    ["silent final consonants: s,t,d,x,z,p","liaison with vowels: s→z, x→z, d→t","obligatory: les/des/mes + vowel","forbidden: et + vowel (no liaison!)","c'est = 'say'","est = 'ay'"],
    [mcq("'Vous êtes' is pronounced:",["voo ay-tuh","vooz ay-tuh","voos ay-tuh","voo ay"],1,"Liaison: silent S in 'vous' becomes Z before 'êtes' (starts with vowel). Result: 'vouz-êtes'. This is what makes French sound flowing and natural!"),
     mcq("'Paris' is pronounced:",["pah-rees","pah-ris","pah-ree","pah-ri"],2,"Final S in Paris is silent! Pah-REE. Most final consonants are silent in French. Exceptions: words ending in C, R, F, L (think: CaReFuL) are usually pronounced."),
     mcq("'Et' (and) followed by a vowel — do you make liaison?",["Yes — 'et' always links","No — 'et' never links","Only in fast speech","Only in formal writing"],1,"'Et' NEVER makes liaison! 'Et elle' = 'ay el' (NOT 'ayt-el'). This is one of the most important liaison rules to avoid a common mistake."),
     wr("How is 'c'est' (it is) pronounced?",["say","c'est"],"C'est = 'say'. The T is silent and E contracts. One of the most common French expressions — you'll use it dozens of times a day: C'est bon, C'est ici, C'est combien?")]),

  mkL("f-05","Essential Greetings",20,"speaking",
    "Greetings are the foundation of every interaction in Canada! Bonjour = used ALL day (not just morning). Bonsoir = evening (after ~6pm). Salut = hi, ONLY with close friends — never with strangers. Au revoir = goodbye. À bientôt = see you soon. Always greet FIRST in Quebec — it's considered rude not to.",
    ["Bonjour (all day)","Bonsoir (evening)","Salut (informal only!)","Au revoir","À bientôt (see you soon)","Bonne journée (have a good day)","Bonne soirée (have a good evening)","Bonne nuit (good night — before sleep)"],
    [mcq("You enter a bank at 2pm. You say:",["Bonsoir","Salut","Bonjour","Bonne nuit"],2,"'Bonjour' is used from morning until about 6-7pm. It means 'good day' not just 'good morning'. Always greet first in Quebec — cashiers, doctors, strangers expect it!"),
     mcq("Your close friend texts 'Salut!' — this means:",["Good evening!","Goodbye!","Hi! (informal)","Please!"],2,"Salut = casual hi/bye with friends. NEVER use with strangers, bosses, or in professional settings. Always use Bonjour with anyone you don't know well!"),
     mcq("When leaving any shop or appointment, you say:",["Bonjour","Salut","Au revoir","Bonsoir"],2,"Au revoir = goodbye (literally 'until we see again'). Always say this leaving stores, clinics, offices. Quebec culture values this basic politeness — it's always noticed!"),
     wr("Write 'have a good day' in French",["bonne journée"],"Bonne journée — said when parting during the day! Cashiers say it to you, you say it back. 'Bonne soirée' = have a good evening. A small phrase that goes a long way in Canada!")]),

  mkL("f-06","Introducing Yourself",25,"speaking",
    "The most important phrases for Canada: Je m'appelle [name] (My name is — literally 'I call myself'), J'ai X ans (I am X years old — French uses AVOIR not être for age!), Je viens de [city/country] (I come from), J'habite à [city] (I live in). These come up at EVERY first meeting, medical appointment, and government office.",
    ["Je m'appelle...","J'ai ... ans (age uses avoir!)","Je viens de... (I come from)","J'habite à... (I live in)","Enchanté(e) (nice to meet you)","Comment vous appelez-vous? (formal)","Tu t'appelles comment? (informal)"],
    [mcq("'My name is Sofia' in French:",["Je suis Sofia","J'ai Sofia","Je m'appelle Sofia","J'habite Sofia"],2,"Je m'appelle = 'I call myself'. THE standard French introduction. Never say 'Mon nom est Sofia' — it sounds like you're reading from a textbook!"),
     mcq("'J'ai 30 ans' means:",["I have 30 things","I am 30 years old","I lived 30 years","I want 30"],1,"French uses AVOIR (to have) for age! J'ai 30 ans = I am 30. NEVER 'Je suis 30 ans' — that's a very common error for English speakers. You 'have' years in French!"),
     mcq("To say WHERE you are FROM:",["J'habite à","Je vais à","Je viens de","Je suis à"],2,"Je viens de = I come from (origin). J'habite à = I currently live in. Different! 'Je viens du Maroc, mais j'habite à Montréal' = I'm from Morocco but I live in Montreal."),
     wr("Say 'I live in Ottawa'",["j'habite à ottawa","j'habite à Ottawa"],"J'habite à Ottawa — habiter à + city = to live in. Essential for any introduction! Vous habitez à...? (formal) or Tu habites à...? (informal) to ask someone else.")]),

  mkL("f-07","Numbers 1–20",20,"listening",
    "Numbers 1-10: un, deux, trois, quatre, cinq, six, sept, huit, neuf, dix. Numbers 11-16 are unique words: onze, douze, treize, quatorze, quinze, seize. 17-19 compound: dix-sept, dix-huit, dix-neuf. 20 = vingt. Critical for prices, addresses, ages, times, phone numbers — everything in daily Canadian life!",
    ["un(1) deux(2) trois(3)","quatre(4) cinq(5) six(6)","sept(7) huit(8) neuf(9)","dix(10) onze(11) douze(12)","treize(13) quatorze(14) quinze(15)","seize(16) dix-sept(17) dix-huit(18)","dix-neuf(19) vingt(20)"],
    [mcq("'Huit' means:",["six","seven","eight","nine"],2,"Huit = eight. Pronounced 'weet' — H is silent! Don't confuse with sept (7) or neuf (9). Tip: think of an octopus (8 legs) = huit!"),
     mcq("17 in French:",["septem","seize","dix-sept","dix-neuf"],2,"Dix-sept = 17 (ten-seven). From 17: dix-sept, dix-huit, dix-neuf — all compound. Then vingt (20). Simple pattern once you know 1-16!"),
     mcq("A price tag says 'quinze dollars' — how much?",["$14","$15","$16","$50"],1,"Quinze = 15. You'll see prices everywhere in Canada — understanding numbers is true survival French. Cinq=5, quinze=15, cinquante=50. Don't confuse!"),
     wr("Write 'twelve' in French",["douze"],"Douze = 12. Numbers 11-16 are unique words you must memorize: onze, douze, treize, quatorze, quinze, seize. No shortcuts — just practice!")]),

  mkL("f-08","Numbers 20–100 & Prices",20,"listening",
    "After 20, French is logical: vingt (20), trente (30), quarante (40), cinquante (50), soixante (60). Then it gets interesting: 70=soixante-dix (60+10), 80=quatre-vingts (4×20), 90=quatre-vingt-dix (4×20+10). Cent=100. For prices: 'C'est combien?' (How much?), 'Ça coûte X dollars' (It costs X dollars).",
    ["vingt(20) trente(30) quarante(40)","cinquante(50) soixante(60)","soixante-dix(70) quatre-vingts(80)","quatre-vingt-dix(90) cent(100)","C'est combien? (How much?)","Ça coûte... (It costs...)","X dollars et X cents"],
    [mcq("80 in French:",["huitante","octante","quatre-vingts","quatre-vingt"],2,"Quatre-vingts = 4×20 = 80! Historical counting system. Note: the 's' disappears before another number: quatre-vingt-cinq (85). In Quebec it's always quatre-vingts — Swiss/Belgian say huitante."),
     mcq("70 in French:",["septante","soixante-dix","soixante-douze","sept-vingt"],1,"Soixante-dix = sixty-ten = 70! So 71=soixante-et-onze, 75=soixante-quinze, 79=soixante-dix-neuf. Yes, it's complicated — but Canadians use this system!"),
     mcq("A store sign says 'quatre-vingt-quinze dollars'. The price is:",["$75","$85","$95","$80"],2,"Quatre-vingts + quinze = 80+15 = 95. So $95! Shopping in Quebec requires knowing these numbers. Practice counting to 100 every day!"),
     wr("How do you ask 'How much does it cost?'",["c'est combien","c'est combien?","combien ça coûte","combien ca coute"],"C'est combien? or Combien ça coûte? — both work perfectly! Use these at any store, market, restaurant, or taxi in Canada. Essential survival French!")]),

  mkL("f-09","Telling Time",20,"listening",
    "Time in French: Il est + number + heures. Il est 9h = It's 9 o'clock. Il est midi = It's noon. Il est minuit = It's midnight. For minutes: Il est 9h15 (9:15), Il est 9h30 (9:30). Formal 24h clock is common in Canada: 14h = 2pm, 20h = 8pm. 'À quelle heure...?' = At what time...?",
    ["Il est... heures (It is... o'clock)","Il est midi (noon)","Il est minuit (midnight)","et quart (quarter past)","et demie (half past)","moins le quart (quarter to)","du matin (am)","de l'après-midi (pm)","À quelle heure? (At what time?)"],
    [mcq("'Il est trois heures' means:",["It is Thursday","It is 3 minutes","It is 3 o'clock","It is the 3rd"],2,"Il est + number + heures = It is X o'clock. Il est trois heures = 3:00. For half past: Il est trois heures et demie = 3:30!"),
     mcq("'À quelle heure est le rendez-vous?' means:",["Where is the appointment?","What time is the appointment?","Who has the appointment?","Why is there an appointment?"],1,"À quelle heure = at what time? Essential for any appointment in Canada! 'Mon rendez-vous est à quatorze heures' (2pm in 24h time)."),
     mcq("14h in 12-hour time is:",["4pm","2pm","1pm","3pm"],1,"24h clock: subtract 12 for pm hours. 14-12=2pm. Canada uses 24h time officially: bus schedules, medical appointments, official documents. Learn it!"),
     wr("Say 'It is half past seven' in French",["il est sept heures et demie","il est 7h30"],"Il est sept heures et demie = 7:30. Et demie = half past. Et quart = quarter past. Moins le quart = quarter to. 'Mon cours est à sept heures et demie du matin!'")]),

  mkL("f-10","Days, Months & Seasons",20,"reading",
    "Days (NOT capitalized in French!): lundi, mardi, mercredi, jeudi, vendredi, samedi, dimanche. Months: janvier, février, mars, avril, mai, juin, juillet, août, septembre, octobre, novembre, décembre. Seasons: le printemps (spring), l'été (summer), l'automne (fall), l'hiver (winter). Dates: le 15 mars 2025.",
    ["lundi(Mon) mardi(Tue) mercredi(Wed)","jeudi(Thu) vendredi(Fri) samedi(Sat)","dimanche(Sun)","aujourd'hui(today) demain(tomorrow) hier(yesterday)","cette semaine(this week) ce mois-ci(this month)","en hiver/été/automne/au printemps"],
    [mcq("Days and months in French are written:",["With capital letters","In lowercase","In ALL CAPS","With accents always"],1,"Lowercase in French! lundi, janvier — not capitalized like English. A very common mistake. Days, months, languages, and nationalities are all lowercase in French."),
     mcq("'Demain' means:",["yesterday","today","tomorrow","next week"],2,"Demain = tomorrow. Hier = yesterday. Aujourd'hui = today. Three essential words for scheduling appointments, meetings, and plans in Canada!"),
     mcq("'L'hiver canadien' refers to:",["spring","summer","fall","winter"],3,"L'hiver = winter. Canadian winters are famous! You'll need: Il fait froid (it's cold), Il neige (it's snowing), Il fait -20°C. 'En hiver' = in winter (no article with seasons after 'en')!"),
     wr("Write today's day in French (any day)",["lundi","mardi","mercredi","jeudi","vendredi","samedi","dimanche"],"Good! Remember: lowercase in French. 'Aujourd'hui c'est [day].' You'll use this constantly for scheduling and conversation.")]),

  mkL("f-11","Politeness Essentials",15,"speaking",
    "Politeness is highly valued in Quebec culture — always greet, always thank, always excuse yourself! S'il vous plaît = please (formal, with strangers). S'il te plaît = please (informal, friends). Merci = thank you. De rien / Avec plaisir = you're welcome. Pardon = excuse me (minor). Excusez-moi = excuse me (stopping someone). Je suis désolé(e) = I'm sorry.",
    ["S'il vous plaît (formal please)","S'il te plaît (informal please)","Merci / Merci beaucoup","De rien (you're welcome)","Avec plaisir (with pleasure)","Pardon (minor excuse me)","Excusez-moi (stopping someone)","Je suis désolé(e) (I'm sorry)"],
    [mcq("Stopping a stranger to ask directions, you say:",["S'il te plaît","De rien","Excusez-moi, s'il vous plaît","Pardon mon ami"],2,"Excusez-moi, s'il vous plaît — to get a stranger's attention. Always formal (vous) with strangers! Pardon is for minor accidents (bumping into someone)."),
     mcq("The cashier says 'Merci!' You respond:",["Bonjour","Salut","De rien","S'il vous plaît"],2,"De rien = you're welcome (literally 'it's nothing'). Also: 'Avec plaisir' (with pleasure) or 'Je vous en prie' (formal). All three are heard in Quebec every day."),
     wr("Write 'I'm sorry' in French (sincere apology)",["je suis désolé","je suis désolée","je suis desole"],"Je suis désolé(e) — the -e at the end is for women. Pardon is for small things, je suis désolé(e) for genuine apologies. Important cultural note: Canadians appreciate sincere apologies!")]),

  mkL("f-12","Survival Phrases",20,"speaking",
    "These 8 phrases will get you through ANY difficult moment as a beginner! 1) Je ne comprends pas (I don't understand). 2) Pouvez-vous répéter? (Can you repeat?). 3) Plus lentement, s'il vous plaît (Slower please). 4) Je parle un peu français (I speak a little French). 5) Parlez-vous anglais? (Do you speak English?). 6) Comment dit-on...? (How do you say...?). 7) Qu'est-ce que ça veut dire? (What does that mean?). 8) Je ne sais pas (I don't know).",
    ["Je ne comprends pas","Pouvez-vous répéter?","Plus lentement SVP","Je parle un peu français","Parlez-vous anglais?","Comment dit-on...?","Qu'est-ce que ça veut dire?","Je ne sais pas (I don't know)"],
    [mcq("You didn't understand. You say:",["Merci beaucoup","Pouvez-vous répéter, s'il vous plaît?","Au revoir","Bonjour"],1,"Pouvez-vous répéter? = Can you repeat? Your most important beginner phrase! Say it confidently — everyone will appreciate that you're trying. Add s'il vous plaît always."),
     mcq("'Je parle un peu français' tells people to:",["speak faster","speak French only","slow down and be patient","stop speaking"],2,"Un peu = a little. This phrase signals: I'm learning, please be patient! Canadians are generally very encouraging to people learning French. Use it proudly!"),
     mcq("'Plus lentement' means:",["more quickly","one more time","more slowly","a little louder"],2,"Plus lentement = more slowly. Plus = more, lentement = slowly. You'll need this constantly when talking with native speakers who naturally speak fast!"),
     wr("Write 'I don't understand' in French",["je ne comprends pas","je ne comprend pas"],"Je ne comprends pas — one of the most important phrases ever! The S at the end of 'comprends' is silent. Say it clearly and without embarrassment — learning means not understanding yet!")]),

  mkL("f-13","Colors & Basic Adjectives",20,"reading",
    "Colors in French (and they agree with noun gender!): rouge (red), bleu/bleue (blue), vert/verte (green), jaune (yellow — no change), noir/noire (black), blanc/blanche (white), orange (orange — no change), rose (pink — no change), gris/grise (grey). Adjectives usually come AFTER the noun in French: une voiture rouge (a red car), un chat noir (a black cat).",
    ["rouge (red — no change)","bleu/bleue (blue)","vert/verte (green)","jaune (yellow — no change)","noir/noire (black)","blanc/blanche (white)","grand/grande (big)","petit/petite (small)","beau/belle (beautiful)","nouveau/nouvelle (new)"],
    [mcq("'Une maison blanche' means:",["a black house","a big house","a white house","a new house"],2,"Blanche = feminine form of blanc (add -he). Maison is feminine → blanche. Blanc/blanche is one of the irregular color adjectives — must memorize the feminine form!"),
     mcq("A car ('la voiture') is red. You say:",["une rouge voiture","une voiture rouge","un voiture rouge","une voiture rouges"],1,"Une voiture rouge — adjective AFTER the noun in French! (Exception: grand, petit, beau, nouveau, jeune, vieux, bon, mauvais come BEFORE). Rouge has no feminine change — it already ends in 'e'!"),
     mcq("'Petit' becomes ___ for feminine nouns:",["petite","petits","peti","petit"],0,"Petit → petite (add -e, and now pronounce the T!). 'Un petit café' (T silent) vs 'Une petite maison' (T pronounced). The added -e changes the pronunciation!"),
     wr("Write 'a big city' in French (city = la ville)",["une grande ville"],"Une grande ville — grand → grande (add -e) for feminine. La ville is feminine. Grande comes BEFORE the noun (it's one of the exceptions!). Montréal est une grande ville!")]),

  mkL("f-14","Family Vocabulary",20,"speaking",
    "Essential family words: la mère/maman (mother/mom), le père/papa (father/dad), le frère (brother), la sœur (sister), le fils (son), la fille (daughter/girl), les grands-parents (grandparents), le grand-père (grandfather), la grand-mère (grandmother), le mari (husband), la femme (wife/woman), les enfants (children), célibataire (single), marié(e) (married).",
    ["la mère (mother)","le père (father)","le frère (brother)","la sœur (sister)","le fils (son)","la fille (daughter/girl)","les enfants (children)","le mari (husband)","la femme (wife/woman)","célibataire (single)","marié(e) (married)"],
    [mcq("'J'ai deux sœurs et un frère' means:",["I have two brothers and a sister","I have two sisters and a brother","I have two children","I have two parents and a brother"],1,"J'ai deux sœurs et un frère — a perfect A1 sentence! Sœur=sister (note the oe ligature), frère=brother. These come up constantly in introductions and CLB speaking tasks."),
     mcq("'La femme' can mean:",["only wife","only woman","wife OR woman","only daughter"],2,"La femme = both 'the woman' AND 'the wife' depending on context! 'Ma femme' = my wife. 'Une femme' = a woman. Context makes it clear — just like English 'partner'."),
     mcq("'Marié(e)' means:",["single","divorced","married","widowed"],2,"Marié(e) = married. The (e) is for women: 'Je suis marié' (man) / 'Je suis mariée' (woman). Célibataire = single. Divorcé(e) = divorced. You'll be asked your status on Canadian forms!"),
     wr("Say 'I have one brother and two children'",["j'ai un frère et deux enfants","j ai un frère et deux enfants"],"J'ai un frère et deux enfants — 'enfants' is plural (children). 'Un enfant' (a child) → 'des enfants' (children/some children). Perfect family introduction sentence!")]),

  mkL("f-15","House & Home Vocabulary",20,"reading",
    "For renting and describing your home in Canada: l'appartement (apartment), la maison (house), la chambre (bedroom), le salon (living room), la cuisine (kitchen), la salle de bain (bathroom), les toilettes (WC/toilet — separate from bathroom in Quebec often!), le balcon (balcony), le sous-sol (basement), le couloir (hallway), la fenêtre (window), la porte (door).",
    ["l'appartement (apartment)","la maison (house)","la chambre (bedroom)","le salon (living room)","la cuisine (kitchen)","la salle de bain (bathroom)","les toilettes (WC)","le balcon (balcony)","le loyer (rent)","les charges (utilities)"],
    [mcq("'J'ai un appartement de 3 chambres' means:",["I have a 3-floor apartment","I have a 3-bedroom apartment","I have a 3-bathroom apartment","I have 3 apartments"],1,"Chambres = bedrooms! In Canadian French housing ads: '3½' means 3 rooms + bathroom (Quebec system). '3 chambres' = 3 bedrooms is standard French."),
     mcq("'La salle de bain' is:",["the dining room","the living room","the bathroom","the kitchen"],2,"La salle de bain = bathroom (with shower/bath). Les toilettes = WC/toilet (often separate room in Quebec apartments!). When apartment hunting, always check both: 'Est-ce qu'il y a une salle de bain et des toilettes séparées?'"),
     wr("Write 'I'm looking for an apartment' in French",["je cherche un appartement","je cherche un appartement."],"Je cherche un appartement — one of the most useful sentences for newcomers! Add details: 'Je cherche un appartement de 2 chambres à louer, avec un loyer maximum de 1200$ par mois.'")]),

  mkL("f-16","Weather & Seasons",15,"speaking",
    "Canada has dramatic weather — you NEED these phrases! Il fait chaud (it's hot), Il fait froid (it's cold), Il fait beau (it's nice out), Il pleut (it's raining), Il neige (it's snowing), Il y a du vent (it's windy), Il y a des nuages (it's cloudy). Temperature: Il fait -10 degrés (It's -10 degrees). Canadian seasons are extreme — knowing weather vocab is practical!",
    ["Il fait chaud/froid (hot/cold)","Il fait beau/mauvais (nice/bad)","Il pleut (it's raining)","Il neige (it's snowing)","Il y a du vent (windy)","Il y a des nuages (cloudy)","Il fait X degrés (X degrees)","Celsius in Canada!"],
    [mcq("'Il neige' means:",["it's raining","it's cold","it's snowing","it's windy"],2,"Il neige = it's snowing. Neiger = to snow (impersonal verb, always il). Il pleut = it's raining. In Quebec: snow from November to April! 'Il neige beaucoup aujourd'hui' = It's snowing a lot today."),
     mcq("'Il fait -15 degrés' — you should wear:",["a t-shirt","light jacket","heavy winter coat","shorts"],2,"Canada uses Celsius! -15°C is very cold — you need a heavy coat, boots, and layers. 'Il fait très froid' = it's very cold. Quebec winters average -15 to -20°C. This is real Canadian survival knowledge!"),
     wr("Say 'It's nice out today' in French",["il fait beau aujourd'hui","il fait beau","il fait beau aujourd hui"],"Il fait beau aujourd'hui — a perfect small talk sentence! Weather is THE most common small talk topic in Canada. Say this to start any friendly conversation at work, in the elevator, or at a bus stop.")]),

  mkL("f-17","Body Parts & Health Basics",20,"speaking",
    "Essential for any medical appointment! La tête (head), le visage (face), les yeux/l'œil (eyes/eye), les oreilles/l'oreille (ears/ear), le nez (nose), la bouche (mouth), le cou (neck), les épaules (shoulders), le dos (back), la poitrine (chest), le ventre (stomach), les bras (arms), les mains (hands), les jambes (legs), les pieds (feet). J'ai mal à = I have pain in.",
    ["la tête (head)","les yeux (eyes)","le nez (nose)","la bouche (mouth)","le cou (neck)","le dos (back)","le ventre (stomach/belly)","la jambe (leg)","le pied (foot)","J'ai mal à... (I have pain in...)"],
    [mcq("'J'ai mal au dos' means:",["I have a headache","I have a stomachache","I have a backache","I have a toothache"],2,"Mal au dos = backache. Pattern: J'ai mal à + body part. 'À + le' = 'au', 'à + la' = 'à la', 'à + les' = 'aux'. J'ai mal aux pieds (my feet hurt), J'ai mal à la gorge (sore throat)."),
     mcq("'Les yeux' is the plural of:",["le yeu","l'eil","l'œil","l'eye"],2,"L'œil (singular) → les yeux (plural) — completely irregular! One of the most irregular plurals in French. 'J'ai mal aux yeux' = my eyes hurt. A doctor will ask: 'Montrez-moi vos yeux.'"),
     wr("Say 'I have a stomachache' in French",["j'ai mal au ventre","j'ai mal à l'estomac","j ai mal au ventre"],"J'ai mal au ventre — mal à + le ventre = mal au ventre. Most common complaint at the pharmacy! You can also say 'J'ai mal à l'estomac' (more formal/anatomical). Both understood everywhere.")]),

  mkL("f-18","Countries & Nationalities",15,"reading",
    "Common countries: le Canada, la France, le Maroc, l'Algérie, la Tunisie, le Sénégal, le Congo, Haïti, le Vietnam, la Chine, le Mexique, le Brésil, les États-Unis. Nationalities agree with gender: canadien/canadienne, français/française, marocain/marocaine. Important: nationalities are LOWERCASE in French! 'Je suis canadien' not 'Je suis Canadien'.",
    ["Je viens de... (I come from)","Je suis + nationality (I am...)","canadien/canadienne","français/française","marocain/marocaine","algérien/algérienne","haïtien/haïtienne","américain/américaine","Les nationalités = lowercase!"],
    [mcq("'Je suis française' — the speaker is:",["a French man","a French woman","from France (unknown gender)","French Canadian"],1,"Française = feminine form of français. The -e ending shows the speaker is a woman. 'Je suis français' (man), 'Je suis française' (woman). Nationalities agree with gender AND are lowercase!"),
     mcq("'Je viens du Maroc' — 'du' is used because:",["Maroc is masculine","Maroc is feminine","Maroc is plural","Maroc starts with M"],0,"Du = de + le (masculine singular). Maroc = le Maroc (masculine). 'Je viens de la France' OR 'Je viens de France' (both work). Countries with 'le/les' use du/des: je viens du Canada, du Mexique."),
     wr("Say 'I am Canadian' (as a woman)",["je suis canadienne"],"Je suis canadienne — with double N and E for feminine. A man says: je suis canadien. You'll use this constantly in Canada! It's also an identity statement — saying it proudly matters.")]),

  mkL("f-19","Shopping Basics",20,"speaking",
    "Shopping vocabulary for Canada: Je cherche... (I'm looking for...), Avez-vous...? (Do you have...?), C'est combien? / Ça coûte combien? (How much?), En quelle taille? (What size?), C'est trop cher (It's too expensive), Pouvez-vous m'aider? (Can you help me?), À la caisse (at the checkout), Payer par carte (pay by card), En espèces (in cash).",
    ["Je cherche... (I'm looking for)","Avez-vous...? (Do you have?)","C'est combien? (How much?)","C'est trop cher (too expensive)","En quelle taille? (What size?)","Payer par carte (pay by card)","En espèces (cash)","Le reçu (receipt)","La caisse (checkout/register)"],
    [mcq("'Je cherche une pharmacie' means:",["I found a pharmacy","I'm looking for a pharmacy","I left the pharmacy","I need a pharmacist"],0,"Je cherche = I'm looking for. Chercher = to look for/search. 'Je cherche un médecin, un appartement, du travail' — one of the most useful A1 verbs for newcomers in Canada!"),
     mcq("To ask if they have a product, you say:",["Avez-vous ce produit?","Où est ce produit?","Je veux ce produit","C'est combien?"],0,"Avez-vous...? = Do you have...? Formal and correct. Informal: Vous avez...? (rising intonation). Essential for any store, pharmacy, or service counter in Canada!"),
     wr("Ask 'Can you help me?' politely in French",["pouvez-vous m'aider","pouvez-vous m'aider?","pouvez vous m'aider"],"Pouvez-vous m'aider? — your emergency phrase at any store, clinic, or office! Pouvez-vous = Can you (formal). M'aider = help me. Add s'il vous plaît: 'Pouvez-vous m'aider, s'il vous plaît?'")]),

  mkL("f-20","Foundation Review & Assessment",25,"integrated",
    "Time to review everything from Foundation! This assessment covers: pronunciation, greetings, numbers, time, days/months, polite phrases, colors, family, body parts, shopping. You should now be able to: introduce yourself, understand basic questions, say numbers up to 100, describe simple things, and navigate basic survival situations in Canada.",
    ["Complete review of all Foundation topics","Introduction: Je m'appelle... J'ai... ans...","Numbers 1-100 fluently","Time: Il est... heures...","Days and months","Colors and adjectives","Family vocabulary","Body parts and J'ai mal à...","Shopping and service phrases"],
    [mcq("Complete the introduction: 'Je m'appelle Maria, ___ 28 ans et je viens du Brésil.'",["suis","ai","vais","es"],1,"J'ai 28 ans — avoir for age! Je m'appelle, J'ai X ans, Je viens de, J'habite à — the 4-sentence self-introduction you should know perfectly after Foundation!"),
     mcq("'Il est quatre-vingt-cinq dollars' means the price is:",["$95","$85","$75","$80"],1,"Quatre-vingts + cinq = 85. But note: no 's' on quatre-vingt before cinq! Quatre-vingts (80 standalone) → quatre-vingt-cinq (85). The 's' disappears before another number."),
     mcq("You bump into someone by accident. You say:",["Bonjour!","De rien","Pardon!","Merci"],2,"Pardon! for minor accidents and brief interruptions. Je suis désolé(e) for more serious apologies. De rien = you're welcome (response to merci, not an apology)!"),
     wr("Introduce yourself in one sentence (name, age, origin, current city)",["je m'appelle","j'ai","je viens","j'habite"],"Perfect! A complete introduction: 'Je m'appelle [name], j'ai [X] ans, je viens de [country] et j'habite à [city].' Practice saying this out loud until it's automatic — you'll use it hundreds of times in Canada!")])
];

// ─────────────────────────────────────────────────────────────────────────────
// A1 — 40 LESSONS
// ─────────────────────────────────────────────────────────────────────────────
const A1_LESSONS = [
  mkL("a1-01","Être — To Be (Full)",25,"speaking",
    "Être is the most important verb in French. MEMORIZE all 6 forms: Je suis, Tu es, Il/Elle/On est, Nous sommes, Vous êtes, Ils/Elles sont. Uses: identity (Je suis médecin), nationality (Elle est canadienne), location with en/au (Nous sommes au Canada), description (C'est difficile). Note: NO article before professions after être! 'Je suis infirmière' NOT 'Je suis une infirmière'.",
    ["Je suis","Tu es","Il/Elle/On est","Nous sommes","Vous êtes","Ils/Elles sont","profession: pas d'article!","C'est = it is"],
    [mcq("'Elle ___ médecin.' Complete correctly.",["suis","es","est","sont"],2,"Elle → est. Il/Elle/On always takes EST. No article before profession: 'Elle est médecin' not 'Elle est une médecin'. This rule applies to all professions after être!"),
     mcq("'Nous ___ au Canada depuis 2 ans.'",["es","est","êtes","sommes"],3,"Nous → sommes. 'Nous sommes au Canada depuis 2 ans' = We have been in Canada for 2 years. Depuis + present tense = ongoing since!"),
     mcq("'Vous ___ bienvenu(e)s!' (You are welcome!)",["suis","es","est","êtes"],3,"Vous → êtes. Works for one person (formal) or many people. 'Vous êtes bienvenu(e)s au Canada!' — a phrase you'll hear and use often!"),
     wr("Say 'I am a nurse' (female speaker)",["je suis infirmière"],"Je suis infirmière — NO 'une'! After être with professions: no article. Man: je suis infirmier. This applies to all jobs: médecin, professeur, ingénieur, etc.")]),

  mkL("a1-02","Avoir — To Have (Full)",25,"speaking",
    "Avoir is essential for possession AND many fixed expressions! Forms: J'ai, Tu as, Il/Elle/On a, Nous avons, Vous avez, Ils/Elles ont. Key expressions using avoir (not être!): J'ai faim (hungry), J'ai soif (thirsty), J'ai chaud/froid (hot/cold), J'ai peur (afraid), J'ai besoin de (need), J'ai X ans (age), J'ai un rendez-vous (appointment).",
    ["J'ai","Tu as","Il/Elle/On a","Nous avons","Vous avez","Ils/Elles ont","J'ai faim/soif/chaud/froid","J'ai besoin de (I need)","J'ai peur (I'm afraid)"],
    [mcq("'J'ai 35 ans' — what does 'ai' come from?",["être","faire","avoir","aller"],2,"Avoir (to have) is used for age in French! J'ai 35 ans = I am 35. NEVER 'Je suis 35 ans' — one of the most common errors English speakers make!"),
     mcq("'J'ai faim' means:",["I have food","I am happy","I am hungry","I have a family"],2,"J'ai faim = I am hungry (literally 'I have hunger'). French uses avoir for physical states: faim(hungry), soif(thirsty), chaud(hot), froid(cold), peur(fear), honte(shame), raison(right), tort(wrong)!"),
     mcq("'Vous ___ des enfants?' (Do you have children?)",["as","a","avez","ont"],2,"Vous → avez. 'Vous avez des enfants?' — a very common question in Canada for newcomers registering with healthcare, schools, social services. Always use 'des' for plural indefinite!"),
     wr("Say 'I have an appointment at 3pm'",["j'ai un rendez-vous à 15h","j'ai un rendez-vous à 3h","j'ai un rendez-vous à trois heures","j'ai un rendez-vous a 15h"],"J'ai un rendez-vous à 15h (or à trois heures de l'après-midi). This sentence is used at EVERY clinic, government office, and professional meeting in Canada!")]),

  mkL("a1-03","Regular -ER Verbs",30,"writing",
    "80% of French verbs are -ER verbs — all follow the same pattern! Remove -er, add endings: je→-e, tu→-es, il/elle→-e, nous→-ons, vous→-ez, ils/elles→-ent. Key -ER verbs: parler (speak), habiter (live), travailler (work), manger (eat), regarder (watch), aimer (like/love), étudier (study), chercher (look for), arriver (arrive), payer (pay).",
    ["parler → je parle","habiter → j'habite (elision!)","travailler → nous travaillons","manger → vous mangez","regarder → ils regardent","aimer → tu aimes","étudier → elle étudie","chercher → je cherche"],
    [mcq("'Nous travaill___' (We work)",["e","es","ons","ez"],2,"Nous + -ER verb ALWAYS = -ons. Nous travaillons, nous habitons, nous parlons. The -ons ending is the most reliable rule in French conjugation!"),
     mcq("Correct: 'Je ___ à Ottawa.' (I live in Ottawa.)",["Je habite à Ottawa","J'habite à Ottawa","Je habitons à Ottawa","Je habitez à Ottawa"],1,"J'habite — elision! When 'je' comes before a vowel sound, drop the 'e' and add apostrophe. J'habite, j'aime, j'arrive, j'étudie, j'ai. This is mandatory in French!"),
     mcq("'Ils travaill___' (They work — masculine)",["e","es","ent","ez"],2,"Ils/Elles + -ER verb = -ent. Ils travaillent. The -ent ending is ALWAYS SILENT! 'Il travaille' and 'Ils travaillent' sound identical — only writing distinguishes them!"),
     wr("Conjugate 'parler' with 'vous' in a question",["vous parlez français?","parlez-vous français?","est-ce que vous parlez français?"],"Vous parlez français? OR Parlez-vous français? OR Est-ce que vous parlez français? — all three question forms are correct! The first (intonation) is most casual, the last (est-ce que) is most beginner-friendly.")]),

  mkL("a1-04","Regular -IR Verbs",25,"writing",
    "The second major verb group! Remove -ir, add: je→-is, tu→-is, il/elle→-it, nous→-issons, vous→-issez, ils/elles→-issent. Common -IR verbs: finir (finish), choisir (choose), réussir (succeed), obéir (obey), remplir (fill), saisir (grab), agir (act), réfléchir (think/reflect). Note: some -IR verbs (partir, sortir, dormir) are IRREGULAR — different lesson!",
    ["finir → je finis","choisir → tu choisis","réussir → il réussit","remplir → nous remplissons","obéir → vous obéissez","réfléchir → ils réfléchissent","je finis, tu finis, il finit","nous finissons, vous finissez, ils finissent"],
    [mcq("'Je fin___' (I finish)",["e","is","it","issons"],1,"Je → -is for -IR verbs. Je finis, tu finis, il finit, nous finissons, vous finissez, ils finissent. Note the -iss- that appears in plural forms!"),
     mcq("'Elle chois___' (She chooses)",["is","it","isse","issent"],1,"Elle → -it. Elle choisit. The T is silent! Compare: je choisis (silent S), il choisit (silent T). In speech, singular forms all sound the same for -IR verbs."),
     mcq("'Vous réuss___' (You succeed)",["it","issons","issez","issent"],2,"Vous → -issez. Vous réussissez. The long -iss- middle is the signature of regular -IR verbs! 'Vous réussissez bien!' = You're doing well! (Common encouragement phrase)"),
     wr("Say 'I choose to study French' using 'choisir'",["je choisis d'étudier le français","je choisis étudier le français"],"Je choisis d'étudier le français — after verbs of choice, use 'de' + infinitive! Choisir de, décider de, essayer de, oublier de. The 'd' before 'étudier' is elision of 'de'.")]),

  mkL("a1-05","Irregular Verbs: Faire, Aller, Venir",30,"speaking",
    "Three essential irregular verbs to memorize completely! FAIRE (to do/make): je fais, tu fais, il fait, nous faisons, vous faites, ils font. ALLER (to go): je vais, tu vas, il va, nous allons, vous allez, ils vont. VENIR (to come): je viens, tu viens, il vient, nous venons, vous venez, ils viennent. These are used in dozens of everyday expressions!",
    ["faire: je fais, tu fais, il fait","faire: nous faisons, vous faites, ils font","aller: je vais, tu vas, il va","aller: nous allons, vous allez, ils vont","venir: je viens, tu viens, il vient","venir: nous venons, vous venez, ils viennent","Ça va? (How's it going?)","d'où venez-vous? (Where do you come from?)"],
    [mcq("'Qu'est-ce que tu ___?' (What are you doing?)",["fait","fais","faites","font"],1,"Tu → fais. Qu'est-ce que tu fais? = What are you doing? VERY common question! 'Je fais mes devoirs' (I'm doing homework), 'Je fais la cuisine' (I'm cooking), 'Il fait beau' (weather — it uses faire too!)"),
     mcq("'Ils ___ au parc.' (They go to the park.)",["va","vont","allez","allons"],1,"Ils → vont. Ils vont au parc. 'Vont' is the most irregular form of aller — must memorize! Je vais, tu vas, il va, nous allons, vous allez, ILS VONT."),
     mcq("'Elle ___ de Montréal.' (She comes from Montreal.)",["viens","vient","venez","viennent"],1,"Elle → vient. 'Elle vient de Montréal' = She comes from Montreal. Venir de + city/country = to come from. Also: 'Je viens d'arriver' (I just arrived — recent past with venir de!)"),
     wr("Say 'We are going to the pharmacy'",["nous allons à la pharmacie","on va à la pharmacie"],"Nous allons à la pharmacie — or 'On va à la pharmacie' (very common in spoken French!). 'On' is used instead of 'nous' in everyday conversation. On va = nous allons!")]),

  mkL("a1-06","Irregular Verbs: Pouvoir, Vouloir, Devoir",30,"speaking",
    "The three modal verbs — express ability, desire, and obligation! POUVOIR (can/be able to): je peux, tu peux, il peut, nous pouvons, vous pouvez, ils peuvent. VOULOIR (want to): je veux, tu veux, il veut, nous voulons, vous voulez, ils veulent. DEVOIR (must/have to): je dois, tu dois, il doit, nous devons, vous devez, ils doivent. Always followed by INFINITIVE!",
    ["pouvoir + inf: je peux parler","vouloir + inf: je veux manger","devoir + inf: je dois partir","puis-je? (may I? — formal)","je voudrais (I would like — polite)","il faut (it is necessary)","on peut (one can/we can)"],
    [mcq("'Je ___ parler avec le médecin.' (I want to speak with the doctor.)",["peux","veux","dois","fais"],1,"Je veux = I want to. Je veux parler avec le médecin. In polite contexts, use 'je voudrais' (I would like) instead — it sounds less demanding! 'Je voudrais parler avec le médecin, s'il vous plaît.'"),
     mcq("'Vous ___ signer ici.' (You must sign here.)",["pouvez","voulez","devez","faites"],2,"Vous devez = you must/have to. Devoir expresses obligation: 'Vous devez remplir ce formulaire' (You must fill out this form). Very common at government offices and clinics!"),
     mcq("'Est-ce que je ___ prendre ce médicament?' (Can I take this medication?)",["veux","dois","peux","fais"],2,"Est-ce que je peux = Can I...? Pouvoir expresses ability/permission. At a pharmacy: 'Est-ce que je peux prendre ce médicament avec de l'alcool?' = Can I take this medication with alcohol?"),
     wr("Say 'I have to call the doctor tomorrow'",["je dois appeler le médecin demain","je dois appeler le docteur demain"],"Je dois appeler le médecin demain — devoir + infinitive = must/have to. 'Demain' = tomorrow. Perfect sentence for managing healthcare in Canada!")]),

  mkL("a1-07","Negation: Ne...Pas and Variations",20,"writing",
    "Negation in French: NE + verb + PAS. Je parle → Je ne parle pas. Before vowels: ne → n'. J'ai → Je n'ai pas. Other negations: ne...jamais (never), ne...plus (no longer), ne...rien (nothing), ne...personne (nobody), ne...que (only). In SPOKEN Quebec French, 'ne' is often dropped: 'Je parle pas', 'J'ai pas'. But ALWAYS write both for CLB!",
    ["je ne parle pas (I don't speak)","je n'ai pas de (no elision!)","ne...jamais (never)","ne...plus (no longer/anymore)","ne...rien (nothing)","ne...personne (nobody)","ne...que (only)","spoken: je parle pas (informal)"],
    [mcq("'I don't have a car.' In French:",["Je n'ai pas une voiture","Je n'ai pas de voiture","Je ne ai pas voiture","Je n'ai pas la voiture"],1,"After negation, un/une/des → DE! Je n'ai pas DE voiture. Je n'ai pas D'argent (elision before vowel). Je n'ai pas DE temps. This DE rule applies every time!"),
     mcq("'Je ne fume jamais' means:",["I don't smoke anymore","I never smoke","I don't smoke at all","I shouldn't smoke"],1,"Ne...jamais = never. Je ne fume jamais = I never smoke. Useful for health forms in Canada! Ne...plus = no longer: 'Je ne fume plus' = I don't smoke anymore."),
     mcq("In spoken Quebec French, you often hear:",["Je ne parle pas","Je ne parle jamais","Je parle pas","Ne parle pas"],2,"'Je parle pas' — in spoken Quebec French, 'ne' is frequently dropped! You'll hear this constantly. But for CLB writing and formal speaking: ALWAYS use 'ne...pas'. Both forms are important to know!"),
     wr("Say 'I no longer live in Montreal' (use ne...plus)",["je n'habite plus à montréal","je ne vis plus à montréal","je n'habite plus a montreal"],"Je n'habite plus à Montréal — ne...plus = no longer/anymore. Note the elision: ne + habite → n'habite. 'Je n'habite plus' is very different from 'Je ne veux plus habiter' (I don't want to live there anymore)!")]),

  mkL("a1-08","Question Forms",25,"speaking",
    "3 ways to ask questions: 1) Rising intonation: 'Tu parles français?' ↗ (most informal). 2) Est-ce que: 'Est-ce que tu parles français?' (recommended for beginners!). 3) Inversion: 'Parles-tu français?' (formal/written). Question words: Où (where), Quand (when), Comment (how), Pourquoi (why), Qui (who), Qu'est-ce que/Que (what), Combien (how much/many), Quel/Quelle (which/what).",
    ["Où est...? (Where is?)","Quand est...? (When is?)","Comment...? (How?)","Pourquoi...? (Why?)","Qui...? (Who?)","Combien de...? (How many/much?)","Quel/Quelle...? (Which/What?)","Est-ce que... (Is it that = question marker)"],
    [mcq("The easiest way to form a question in French:",["Add -er to the verb","Use est-ce que + normal sentence","Put ne...pas around the verb","Always invert subject-verb"],1,"Est-ce que + normal word order = any statement becomes a question! 'Tu parles français' → 'Est-ce que tu parles français?' No word order change. Perfect for beginners!"),
     mcq("'Quel est votre numéro de téléphone?' means:",["What is your phone number?","Where is your phone?","How is your phone?","Who has your phone?"],0,"Quel/Quelle = which/what (agrees with noun gender). Quel est ton... (masculine), Quelle est ta... (feminine). 'Quel est votre numéro?' (polite/formal) is asked constantly in Canada!"),
     mcq("'Pourquoi vous apprenez le français?' asks:",["When you're learning French","Where you're learning French","Why you're learning French","How you're learning French"],2,"Pourquoi = why. Common question for newcomers in Canada! Great answer: 'J'apprends le français parce que je veux travailler et m'intégrer au Canada.'"),
     wr("Ask 'When does the pharmacy open?' in French",["quand est-ce que la pharmacie ouvre?","quand la pharmacie ouvre?","à quelle heure ouvre la pharmacie?"],"Quand est-ce que la pharmacie ouvre? OR À quelle heure ouvre la pharmacie? — both excellent! The second (à quelle heure) specifically asks about time, which is usually what you want to know!")]),

  mkL("a1-09","Articles (Definite, Indefinite, Partitive)",25,"reading",
    "French articles are essential — every noun needs one! DEFINITE (the): le (m), la (f), l' (before vowel), les (pl). INDEFINITE (a/an): un (m), une (f), des (pl). PARTITIVE (some — for uncountable): du (= de+le), de la, de l', des. After negation: un/une/des/du/de la → DE. Examples: Je mange du pain (I eat some bread), Je n'ai pas de pain (I have no bread).",
    ["le/la/l'/les (the)","un/une/des (a/an/some)","du/de la/de l'/des (some — partitive)","pas de/d' (after negation)","à + le = au, à + les = aux","de + le = du, de + les = des"],
    [mcq("'Je voudrais ___ café.' (I would like a coffee.)",["le","la","un","une"],2,"Un café — café is masculine and we want 'A' coffee (indefinite). Un = a (masculine). Une = a (feminine). Perfect for any Canadian café order!"),
     mcq("'Je bois ___ eau tous les matins.' (I drink some water every morning.)",["la","une","de la","du"],2,"De l'eau — partitive article before vowel! 'Eau' starts with E → de l'eau (not 'de la eau'). Partitive = some/an amount of. Used for uncountable things: de l'eau, du pain, de la patience."),
     mcq("After negation: 'Je ne mange pas ___ viande.' (I don't eat meat.)",["la","une","de la","de"],3,"After negation: un/une/des/du/de la → DE. Je ne mange pas DE viande. Je ne bois pas D'alcool. This DE rule is one of the most important grammar rules in French!"),
     wr("Write 'I have some time today' in French",["j'ai du temps aujourd'hui","j ai du temps aujourd'hui"],"J'ai du temps aujourd'hui — 'temps' is masculine, so 'du' (de + le). Partitive for uncountable noun. 'Avez-vous du temps?' = Do you have (some) time? Very useful for scheduling in Canada!")]),

  mkL("a1-10","Possessive Adjectives",20,"reading",
    "Possessives agree with the NOUN they describe (not the owner!): mon/ma/mes (my), ton/ta/tes (your-informal), son/sa/ses (his/her/its), notre/nos (our), votre/vos (your-formal/plural), leur/leurs (their). Important: before feminine nouns starting with vowel, use MON/TON/SON! 'Mon amie' not 'Ma amie' (sounds bad). Examples: mon père, ma mère, mon école (feminine but vowel!).",
    ["mon/ma/mes (my)","ton/ta/tes (your - informal)","son/sa/ses (his/her/its)","notre/nos (our)","votre/vos (your - formal)","leur/leurs (their)","Before vowel: mon/ton/son (even feminine!)"],
    [mcq("'___ médecin est excellent.' (My doctor — feminine noun starting with M)",["Ma","Mon","Mes","Mes"],1,"Mon médecin — even though 'médecin' can refer to a woman, the noun itself uses 'mon'. But also: médecin is actually used as masculine in French regardless. 'Mon médecin de famille est disponible aujourd'hui.'"),
     mcq("'C'est ___ appartement.' (It's his apartment.)",["mon","ma","son","sa"],2,"Son = his/her/its (before masculine noun). 'Son appartement' = his/her apartment. Note: 'son' works for both masculine and feminine owners — context tells you which! 'C'est son appartement à elle' clarifies it's hers."),
     mcq("'Votre ___ de naissance, s'il vous plaît?' (Your date of birth please?)",["date","la date","mon","son"],0,"Votre date de naissance — 'votre' is the formal/plural possessive. Always use 'votre' with strangers, officials, doctors in Canada. 'Votre nom? Votre prénom? Votre numéro de téléphone?' — standard questions!"),
     wr("Write 'my health card' in French",["ma carte-santé","ma carte santé"],"Ma carte-santé — feminine noun (la carte) → ma carte. 'Avez-vous votre carte-santé?' = Do you have your health card? You'll hear this at EVERY medical appointment in Quebec!")]),

  mkL("a1-11","Demonstratives: Ce, Cet, Cette, Ces",20,"reading",
    "Demonstrative adjectives = this/that/these/those in French. CE (masculine singular): ce livre (this book). CET (masculine singular before vowel/h): cet homme, cet appartement. CETTE (feminine singular): cette maison. CES (all plurals): ces enfants. To distinguish 'this' vs 'that', add -ci (this) or -là (that): ce livre-ci (this book), ce livre-là (that book).",
    ["ce + m.singular (ce livre)","cet + m.vowel/h (cet hôpital)","cette + f.singular (cette maison)","ces + plural (ces documents)","ce...ci (this one — nearby)","ce...là (that one — far)","C'est = it is / this is","Ce sont = these are / those are"],
    [mcq("'___ formulaire est important.' (This form is important.)",["Cet","Ce","Cette","Ces"],1,"Ce formulaire — formulaire is masculine and starts with F (not a vowel), so use CE. If it started with a vowel or H: CET. Ce formulaire, cet appartement, cette maison!"),
     mcq("'___ école est excellente.' (This school is excellent.)",["Ce","Cet","Cette","Ces"],2,"Cette école — école is feminine → cette. Also: note 'école' starts with E, but since it's feminine we use CETTE not CET (cet is only for masculine nouns starting with vowel/h)!"),
     mcq("'Signez ___ documents, s'il vous plaît.' (Sign these documents please.)",["ce","cet","cette","ces"],3,"Ces documents — plural → ces. 'Ces' works for all genders in plural: ces hommes, ces femmes, ces enfants, ces documents. Very common at government offices: 'Remplissez ces formulaires!'"),
     wr("Write 'this apartment has 3 bedrooms'",["cet appartement a 3 chambres","cet appartement a trois chambres"],"Cet appartement a 3 chambres — 'appartement' starts with A (vowel) → CET (not CE). 'Cet appartement est disponible?' = Is this apartment available? Critical vocabulary for apartment hunting in Canada!")]),

  mkL("a1-12","Prepositions of Place",20,"reading",
    "Prepositions for location — essential for giving/understanding directions! sur (on), sous (under), devant (in front of), derrière (behind), à côté de (next to), entre (between), en face de (across from), dans (in/inside), près de (near), loin de (far from), au bout de (at the end of), au coin de (at the corner of). With countries: en + feminine (en France), au + masculine (au Canada), aux + plural (aux États-Unis).",
    ["sur/sous (on/under)","devant/derrière (in front of/behind)","à côté de (next to)","entre (between)","en face de (across from)","près de/loin de (near/far from)","en + pays féminin (en France)","au + pays masculin (au Canada)","aux + pays pluriel (aux États-Unis)"],
    [mcq("'La pharmacie est ___ côté de la banque.' (next to)",["en","à","au","sur"],1,"À côté de = next to. Note: 'à côté de' not 'en côté de'! Other location phrases: en face de (across from), au bout de (at the end of), au coin de (at the corner of)."),
     mcq("'J'habitais ___ Maroc avant.' (I used to live in Morocco.)",["en","au","à","aux"],1,"Au Maroc — Maroc is masculine (le Maroc), so use AU. En = feminine countries (en France, en Algérie, en Tunisie). Au = masculine (au Canada, au Maroc, au Mexique). Aux = plural (aux États-Unis)!"),
     mcq("'Le bureau est ___ entre la bibliothèque et le café.' The office is:",["on top of library and café","between the library and the café","across from library and café","behind library and café"],1,"Entre = between. 'Le bureau est entre la bibliothèque et le café.' Essential for giving/understanding directions in Canadian cities!"),
     wr("Say 'The hospital is near the metro station'",["l'hôpital est près de la station de métro","l'hôpital est près de la station","l'hopital est près de la station de métro"],"L'hôpital est près de la station de métro — très bien! 'Près de' = near (followed by de). Always add de after près, loin, à côté, en face, au bout!")]),

  mkL("a1-13","Adverbs of Frequency & Time",20,"reading",
    "How often? toujours (always), souvent (often), parfois/quelquefois (sometimes), rarement (rarely), jamais (never — with ne). When? maintenant (now), bientôt (soon), déjà (already), encore (still/again), encore une fois (once more), tout de suite (right away), hier (yesterday), aujourd'hui (today), demain (tomorrow), la semaine prochaine (next week).",
    ["toujours (always)","souvent (often)","parfois/quelquefois (sometimes)","rarement (rarely)","jamais (never)","maintenant (now)","bientôt (soon)","déjà (already)","encore (still/again)","tout de suite (right away)"],
    [mcq("'Je ne fume jamais' means:",["I rarely smoke","I never smoke","I don't smoke anymore","I sometimes smoke"],1,"Ne...jamais = never. Different from ne...plus (no longer). 'Je ne fume jamais' = I have never smoked and I never will. Health forms in Canada often ask: 'Fumez-vous?' (Do you smoke?)"),
     mcq("'C'est déjà fait!' means:",["It's not done yet","It's done already!","It will be done soon","It should be done"],1,"Déjà = already. 'C'est déjà fait!' = It's already done! Very useful in work contexts. 'Avez-vous déjà rempli le formulaire?' = Have you already filled out the form?"),
     mcq("'Tout de suite' means:",["in a while","later today","right away/immediately","next week"],2,"Tout de suite = right away/immediately. 'Je reviens tout de suite' = I'll be right back. You'll hear this at service counters constantly! 'Un moment, s'il vous plaît — je reviens tout de suite.'"),
     wr("Write a sentence using 'parfois' (sometimes)",["parfois je","je parle parfois","je mange parfois","je travaille parfois"],"Parfois je mange au restaurant = Sometimes I eat at a restaurant. Or: Je parle parfois avec des voisins = I sometimes talk with neighbors. Adverbs usually go AFTER the verb in French!")]),

  mkL("a1-14","Near Future: Aller + Infinitive",25,"speaking",
    "The most natural way French people talk about future plans! Formula: aller (conjugated) + infinitive. Je vais manger (I'm going to eat), Tu vas travailler (You're going to work), Il va appeler (He's going to call), Nous allons partir (We're going to leave), Vous allez voir (You're going to see), Ils vont arriver (They're going to arrive). This is used MORE than the future tense in everyday French!",
    ["je vais + infinitif","tu vas + infinitif","il/elle va + infinitif","nous allons + infinitif","vous allez + infinitif","ils/elles vont + infinitif","demain je vais... (tomorrow I'm going to)","ce soir on va... (tonight we're going to)"],
    [mcq("'Il ___ téléphoner au médecin.' (He's going to call the doctor.)",["va","vont","allez","vais"],0,"Il → va. Il va téléphoner au médecin. Near future: 'je vais, tu vas, il VA, nous allons, vous allez, ils vont' — this form is used constantly for plans, intentions, and imminent actions!"),
     mcq("'Je vais remplir ce formulaire' means:",["I filled out this form","I'm filling out this form","I'm going to fill out this form","I should fill out this form"],2,"Aller + infinitive = near future (going to do). 'Je vais remplir ce formulaire' = I'm going to fill out this form. The most common way to express future intention in everyday Canadian French!"),
     mcq("'Qu'est-ce que vous allez faire ce soir?' means:",["What did you do tonight?","What are you doing tonight?","What are you going to do tonight?","What should you do tonight?"],2,"Qu'est-ce que vous allez faire = What are you going to do? This is how Canadians actually ask about plans. 'Ce soir' = tonight. A very natural conversational question!"),
     wr("Say 'Tomorrow I'm going to go to the doctor'",["demain je vais aller chez le médecin","demain je vais aller chez le docteur","demain je vais voir le médecin"],"Demain je vais aller chez le médecin — aller chez + person = go to (someone's place/office). 'Chez le médecin, chez le dentiste, chez le pharmacien.' This structure is used constantly!")]),

  mkL("a1-15","Depuis, Il y a, Pendant (Time Expressions)",25,"writing",
    "Three key time expressions English speakers struggle with! DEPUIS + present = ongoing action (started in past, still happening): 'J'habite ici depuis 3 ans' (I've lived here for 3 years). IL Y A + past = completed time ago: 'Je suis arrivé il y a 3 ans' (I arrived 3 years ago). PENDANT + any tense = during/for a duration: 'J'ai travaillé pendant 5 ans' (I worked for 5 years — finished).",
    ["depuis + présent (ongoing!): j'habite depuis","il y a + passé composé: je suis arrivé il y a","pendant + durée: j'ai étudié pendant 3 ans","ça fait [durée] que + présent (same as depuis)","depuis quand? (since when?)","depuis combien de temps? (for how long?)"],
    [mcq("'J'apprends le français depuis 6 mois.' means:",["I learned French 6 months ago","I learned French for 6 months (finished)","I have been learning French for 6 months (ongoing)","I will learn French for 6 months"],2,"Depuis + PRESENT = still ongoing! 'J'apprends depuis 6 mois' = I've been learning for 6 months (and I'm still learning now). If you stopped: 'J'ai étudié pendant 6 mois' (passé composé + pendant)."),
     mcq("'Je suis arrivé au Canada ___ 2 ans.' (2 years ago — completed)",["depuis","pendant","il y a","pour"],2,"Il y a = ago (for completed events). Il y a 2 ans = 2 years ago. 'Je suis arrivé au Canada il y a 2 ans' = I arrived in Canada 2 years ago. Depuis would imply you've been 'arriving' for 2 years — illogical!"),
     mcq("'J'ai travaillé dans ce restaurant ___ 3 ans.' (for 3 years — finished)",["depuis","il y a","pendant","ça fait"],2,"Pendant = for/during (completed duration). 'J'ai travaillé pendant 3 ans' = I worked for 3 years (then I stopped). The passé composé + pendant signals completion. If still working: 'Je travaille depuis 3 ans' (present + depuis)!"),
     wr("Say 'I have been living in Canada for 4 years' (ongoing)",["j'habite au canada depuis 4 ans","j'habite au canada depuis quatre ans","j'habite ici depuis 4 ans"],"J'habite au Canada depuis 4 ans — present tense + depuis! 'Depuis combien de temps habitez-vous au Canada?' = How long have you been living in Canada? This question is asked at EVERY immigration-related appointment!")]),

  mkL("a1-16","Daily Routine Reflexive Verbs",25,"speaking",
    "Reflexive verbs describe actions done to/for yourself. Use reflexive pronouns: me (je), te (tu), se (il/elle), nous, vous, se (ils/elles). Common ones: se réveiller (wake up), se lever (get up), se laver (wash), se doucher (shower), se brosser les dents (brush teeth), s'habiller (get dressed), se maquiller (put on makeup), se raser (shave), se coucher (go to bed), se reposer (rest).",
    ["je me réveille","tu te lèves","il/elle se douche","nous nous lavons","vous vous habillez","ils/elles se couchent","Le matin, d'abord je me...","Le soir, je me couche à..."],
    [mcq("'Je me lève à 7h' means:",["I fall asleep at 7","I wake up at 7","I get up at 7","I eat at 7"],2,"Se lever = to get up (physically get out of bed). Se réveiller = to wake up (become conscious). Both happen every morning — first you wake up, then you get up! 'Je me réveille à 6h30 et je me lève à 7h.'"),
     mcq("'Vous ___ les dents tous les soirs?' (You brush your teeth every evening?)",["vous brossez","vous vous brossez","vous vous brosse","vous brossez-vous"],1,"Vous vous brossez les dents — reflexive verb needs BOTH the conjugated verb AND the reflexive pronoun! 'Vous vous brossez' = vous + se + brosser → vous vous brossez."),
     mcq("'Ils se ___ à 23h.' (They go to bed at 11pm.)",["couche","couchent","couchons","couchez"],1,"Ils/elles + reflexive = ils SE + verb ending in -ent. Ils se couchent à 23h. The -ent is silent! 'Ils se couchent tôt pendant la semaine' = They go to bed early on weekdays."),
     wr("Describe your morning in 2 sentences using reflexive verbs",["je me réveille","je me lève","je me douche","je m'habille","je me brosse"],"Sample: 'Le matin, je me réveille à 6h et je me lève immédiatement. Je me douche, je m'habille, et je prends le bus.' This type of routine description is a CORE CLB 4 speaking task!")]),

  mkL("a1-17","Adjective Agreement Rules",20,"reading",
    "Adjectives in French agree in GENDER and NUMBER with the noun they describe! Basic rule: add -E for feminine, -S for plural, -ES for feminine plural. Exceptions: adjectives already ending in -E don't change (rouge, jeune, facile). Irregular: bon→bonne, beau→belle, blanc→blanche, long→longue, public→publique, gentil→gentille. Position: most adjectives AFTER noun, but BAGS (Beauty, Age, Goodness, Size) go BEFORE!",
    ["masculin→féminin: grand→grande","singulier→pluriel: grand→grands","déjà en -e: rouge (pas de changement)","irréguliers: beau→belle, blanc→blanche","AVANT le nom: beau, vieux, nouveau, petit, grand, bon","APRÈS le nom: rouge, intelligent, canadien..."],
    [mcq("'Un grand homme' vs 'Une grande femme'. 'Grand' goes ___ the noun:",["after","before","it depends","it doesn't matter"],1,"Grand/grande goes BEFORE the noun — it's a BAGS adjective (Size). 'Un grand appartement', 'une grande ville', 'un grand médecin'. Compare: 'Un médecin compétent' (competent goes AFTER)!"),
     mcq("Feminine of 'beau' (beautiful):",["beau","beaue","belle","beaux"],2,"Beau → belle (completely irregular!). 'Un beau garçon, une belle femme'. Also: beau → beaux (plural m), beau → belles (plural f). Similarly: nouveau→nouvelle, vieux→vieille!"),
     mcq("'Les enfants sont content___.' (The children are happy.)",["(no change)","e","s","es"],2,"Les enfants (masculine plural) → contents (add -s). If feminine: 'Les filles sont contentes' (add -es). Adjective agrees with noun: content, contente, contents, contentes!"),
     wr("Write 'a new Canadian hospital' in French",["un nouvel hôpital canadien","un nouveau hôpital canadien"],"Un nouvel hôpital canadien — 'nouveau' becomes 'nouvel' before masculine nouns starting with vowel/H (like 'cet'). 'Canadien' goes AFTER (nationality adjective). Great sentence demonstrating adjective rules!")]),

  mkL("a1-18","Making Appointments & Requests",25,"speaking",
    "Essential for daily life in Canada! Making appointments: 'Je voudrais prendre un rendez-vous avec le docteur X.' / 'Avez-vous de la disponibilité le mardi?' Polite requests: 'Pourriez-vous...?' (Could you...?), 'Est-ce qu'il serait possible de...?' (Would it be possible to...?), 'J'aurais besoin de...' (I would need...). Confirming/cancelling: 'Je confirme mon rendez-vous', 'Je dois annuler / reporter mon rendez-vous'.",
    ["Je voudrais prendre un rendez-vous","Avez-vous de la disponibilité?","Quel jour vous conviendrait?","Je confirme mon rendez-vous du...","Je dois annuler/reporter","À quelle heure êtes-vous disponible?","Pourriez-vous me rappeler?","Je vous rappelle mon numéro:"],
    [mcq("To make a polite appointment request, you say:",["Je veux un rendez-vous maintenant","Je voudrais prendre un rendez-vous, s'il vous plaît","Donnez-moi un rendez-vous","Rendez-vous!"],1,"Je voudrais prendre un rendez-vous, s'il vous plaît — the conditional 'voudrais' makes it polite. Then: avec quel médecin? Pour quand? En matinée ou après-midi? These are the follow-up questions!"),
     mcq("'Je dois annuler mon rendez-vous' means:",["I want to make an appointment","I need to move my appointment","I need to cancel my appointment","I confirmed my appointment"],2,"Annuler = to cancel. Reporter = to reschedule/postpone. 'Je dois annuler mon rendez-vous de vendredi' = I need to cancel my Friday appointment. Always call ahead — cancelling is expected and polite!"),
     wr("Write a polite request to reschedule an appointment",["je dois reporter mon rendez-vous","je voudrais reporter","je dois annuler et reprendre un rendez-vous","je voudrais changer mon rendez-vous"],"'Je dois reporter mon rendez-vous. Serait-il possible de le déplacer à la semaine prochaine?' Perfect sentence! Reporter = to reschedule, déplacer = to move. Both are correct for appointment changes.")]),

  mkL("a1-19","Transportation & Directions (Full)",25,"listening",
    "Getting around Canada requires specific vocabulary! Questions: 'Où est l'arrêt de bus/la station de métro?' (Where is the bus stop/metro station?), 'Comment aller à...?' (How do I get to...?), 'Quel bus/métro va à...?' (Which bus/metro goes to...?). Directions: tournez à gauche/droite (turn left/right), allez tout droit (go straight), traversez (cross), prenez (take), descendez à (get off at), correspondance (transfer).",
    ["l'arrêt de bus (bus stop)","la station de métro","prenez le bus numéro... (take bus #)","descendez à... (get off at)","la correspondance (transfer)","tournez à gauche/droite","allez tout droit","c'est à X minutes à pied (X min walk)","à pied/en bus/en métro/en voiture"],
    [mcq("'Descendez à la prochaine station' means:",["Get on at the next station","Transfer at the next station","Get off at the next station","Wait at the next station"],2,"Descendre = to get off (public transport). 'Descendez à...' = Get off at... 'Où dois-je descendre?' = Where should I get off? Essential for taking buses and metro in Montreal, Ottawa, or Quebec City!"),
     mcq("'La correspondance' at a metro station means:",["the exit","the ticket office","the transfer point (to change lines)","the lost and found"],2,"La correspondance = transfer/connection. 'Prenez la correspondance à la station Berri-UQAM' = Transfer at Berri-UQAM station. You'll see this in transit maps and hear it in announcements!"),
     wr("Ask how to get to the nearest hospital",["comment aller à l'hôpital le plus proche?","où est l'hôpital le plus proche?","comment est-ce que je peux aller à l'hôpital?"],"Comment aller à l'hôpital le plus proche? — 'le plus proche' = the nearest (superlative). Or simply: 'Où est l'hôpital?' If urgent: 'J'ai besoin d'aller à l'urgence tout de suite!' = I need to get to the ER right away!")]),

  mkL("a1-20","Food & Restaurants (Full)",25,"speaking",
    "Complete restaurant and food vocabulary for Canada! Menus: les entrées (appetizers/starters), les plats principaux (main courses), les desserts, les boissons (drinks). Ordering: 'Je prends...' (I'll have...), 'Pour moi...' (For me...), 'Qu'est-ce que vous recommandez?' (What do you recommend?). Dietary: végétarien/végétalien (vegetarian/vegan), sans gluten (gluten-free), allergie à (allergy to), sans noix (without nuts).",
    ["Je prends... / Pour moi...","Qu'est-ce que vous recommandez?","C'est quoi, exactement? (What is it exactly?)","C'est délicieux! (It's delicious!)","végétarien/végétalien","sans gluten/sans noix","Je suis allergique à...","L'addition, s'il vous plaît","Est-ce que le service est inclus? (Is service included?)"],
    [mcq("'Pour moi, le saumon, s'il vous plaît.' means:",["I am salmon","The salmon is for me, please","I like salmon","I recommend the salmon"],1,"'Pour moi' = for me — a very natural way to order in French restaurants. Also: 'Je prends le saumon' = I'll have the salmon. Both are polite and natural — avoid 'Je veux' (I want) which sounds too direct!"),
     mcq("'Je suis allergique aux arachides' means:",["I like peanuts","I don't eat peanuts for religious reasons","I am allergic to peanuts","I can't find peanuts"],2,"Allergique aux arachides = allergic to peanuts (arachides is the Canadian French word — not 'cacahuètes' which is France French!). 'Aux' = à + les. Critical health information — always communicate food allergies clearly in French!"),
     wr("Order a vegetarian dish politely",["je voudrais un plat végétarien","je prends le plat végétarien","est-ce que vous avez des plats végétariens?"],"Je voudrais un plat végétarien, s'il vous plaît — or ask first: 'Est-ce que vous avez des plats végétariens?' (Do you have vegetarian dishes?). In Quebec, most restaurants now have vegetarian options — don't be shy to ask!")]),

  mkL("a1-21","Shopping & Money",25,"speaking",
    "Shopping in Canada: Les soldes (sales), Le rabais/La réduction (discount), Le prix (price), La caisse (checkout), Le reçu (receipt), La facture (invoice/bill), Payer (to pay), Rembourser (to refund), Échanger (to exchange), La garantie (warranty). Asking for help: 'Excusez-moi, je cherche...' (Excuse me, I'm looking for...), 'Quelle est votre politique de retour?' (What's your return policy?)",
    ["les soldes (sales)","le rabais/la réduction (discount)","le prix (price)","la caisse (checkout)","le reçu (receipt)","rembourser (to refund)","échanger (to exchange)","la garantie (warranty)","Quelle est votre politique de retour?","En avez-vous une autre taille? (Do you have another size?)"],
    [mcq("'Le magasin est en solde' means:",["The store is sold out","The store is on sale","The store is closed","The store is full"],1,"En solde = on sale. 'Les soldes' = the sales (events). 'C'est en solde' = it's on sale. 'Avez-vous d'autres articles en solde?' = Do you have other items on sale? Great question during Canadian Boxing Day (26 décembre) or Black Friday!"),
     mcq("'Je voudrais échanger ce pantalon' means:",["I want to buy this pants","I want to return this pants for money back","I want to exchange these pants (for another)","I want to try on these pants"],2,"Échanger = to exchange (for a different size/color/item). Rembourser = to refund (get money back). 'Est-ce que je peux l'échanger? Il est trop grand.' = Can I exchange it? It's too big."),
     wr("Ask for a different size in French",["est-ce que vous avez une autre taille?","avez-vous ce modèle en taille L?","est-ce que vous avez ce pantalon en plus grand?"],"Est-ce que vous avez une autre taille? — 'une autre taille' = another size. Or be specific: 'Est-ce que vous avez ce modèle en taille médium?' (Do you have this in a medium?) Always polite to ask!")]),

  mkL("a1-22","Workplace French Basics",25,"speaking",
    "Essential French for Canadian workplaces! Asking questions: 'Pourriez-vous m'expliquer...?' (Could you explain...?), 'Je n'ai pas bien compris...' (I didn't quite understand...), 'Pouvez-vous répéter plus lentement?' Describing your role: 'Je suis responsable de...' (I'm responsible for...), 'Ma tâche principale est de...' (My main task is...). Professional phrases: 'C'est noté' (Noted), 'Je m'en occupe' (I'll take care of it), 'Je vous envoie ça tout de suite' (I'll send that right away).",
    ["Pourriez-vous m'expliquer?","Je n'ai pas bien compris","Je suis responsable de (I'm in charge of)","Ma tâche principale (my main task)","C'est noté (noted)","Je m'en occupe (I'll handle it)","À quelle heure est la réunion? (meeting time?)","Je vous envoie ça par courriel (I'll email that)"],
    [mcq("'Je m'en occupe' in a work context means:",["I forget about it","I'll take care of it","I'm occupied","I don't know"],1,"Je m'en occupe = I'll take care of/handle it. A very professional and useful phrase! 'Pouvez-vous préparer ce rapport?' 'Oui, je m'en occupe!' Perfect for showing competence in a Canadian workplace."),
     mcq("'C'est noté' is used when:",["you disagree with something","you've received and acknowledged information","you're taking notes for others","you need to write something"],1,"C'est noté = noted / got it. Professional way to acknowledge information without repeating it all back. 'La réunion est reportée à vendredi.' 'C'est noté, merci.' Very common in Canadian offices!"),
     wr("Tell your manager you'll send an email right away",["je vous envoie ça tout de suite","je vous envoie par courriel tout de suite","je vais vous envoyer ça immédiatement"],"Je vous envoie ça tout de suite / Je vous envoie ça par courriel tout de suite — professional and reassuring! 'Par courriel' = by email. Remember: 'courriel' is the Quebec French word for email — not 'email' in formal Quebec contexts!")]),

  mkL("a1-23","School & Education Vocabulary",20,"reading",
    "For parents and students navigating Canadian schools! L'école primaire/secondaire (elementary/high school), le cégep (Quebec college — unique to Quebec!), l'université (university), la classe/le cours (class/course), le professeur/l'enseignant(e) (teacher), les devoirs (homework), la note (grade), le bulletin (report card), l'inscription (registration), les frais de scolarité (tuition).",
    ["l'école primaire/secondaire","le cégep (Quebec college)","l'université","le cours (course/class)","les devoirs (homework)","la note/la cote (grade)","le bulletin (report card)","s'inscrire (to register)","les frais de scolarité (tuition)","la garderie (daycare)","le service de garde (before/after school care)"],
    [mcq("'Le cégep' is unique to:",["France","Belgium","Quebec, Canada","Switzerland"],2,"Le cégep (Collège d'enseignement général et professionnel) exists ONLY in Quebec! It's between high school and university — a mandatory step for Quebec students. If your child studies in Quebec, they'll go through the cégep system!"),
     mcq("'Les devoirs' means:",["the teachers","the homework","the grades","the exams"],1,"Les devoirs = homework. 'Mon enfant a beaucoup de devoirs ce soir' = My child has a lot of homework tonight. Other school vocab: l'examen (exam), le contrôle (quiz/test), le bulletin (report card)."),
     wr("Ask what time school ends",["à quelle heure est-ce que l'école finit?","l'école finit à quelle heure?","à quelle heure se termine l'école?"],"À quelle heure est-ce que l'école finit/se termine? — essential for childcare planning in Canada! Also: 'Y a-t-il un service de garde?' (Is there before/after school care?) Very practical for working parents!")]),

  mkL("a1-24","Emergency & Safety Language",20,"speaking",
    "Critical French for emergencies in Canada! Emergency numbers: 911 (police, fire, ambulance). 'Au secours!' / 'À l'aide!' (Help!). 'Appelez une ambulance!' (Call an ambulance!). 'Il y a un accident!' (There's an accident!). 'J'ai perdu...' (I lost...). 'On m'a volé...' (I was robbed of...). 'J'ai besoin d'aide immédiatement' (I need help immediately). At the hospital: 'C'est urgent!' (It's urgent!), 'J'ai du mal à respirer' (I have difficulty breathing).",
    ["Au secours! / À l'aide! (Help!)","Appelez une ambulance/la police!","Il y a un accident/incendie!","C'est urgent! (It's urgent!)","J'ai du mal à respirer (difficulty breathing)","J'ai perdu mon passeport/portefeuille","On m'a volé... (I was robbed of...)","Je me suis perdu(e) (I'm lost)","Le 911 (emergency number Canada)"],
    [mcq("Canada's emergency number is:",["999","112","911","118"],2,"911 is the universal emergency number in Canada for police, fire, and ambulance. Say 'J'ai besoin d'une ambulance' or 'Il y a un incendie' (There's a fire). 911 operators in Quebec can assist in French!"),
     mcq("'J'ai du mal à respirer' means:",["I have a headache","I'm having difficulty breathing","I'm in pain","I feel dizzy"],1,"J'ai du mal à respirer = I'm having difficulty breathing. 'Avoir du mal à + infinitive' = to have difficulty doing something. CRITICAL medical phrase for emergencies! Also: 'J'ai du mal à marcher' (difficulty walking)."),
     wr("Say 'I lost my health card' in French",["j'ai perdu ma carte-santé","j'ai perdu ma carte santé"],"J'ai perdu ma carte-santé — very important! Report immediately to the RAMQ (Quebec) to get a replacement. Also useful: 'J'ai perdu mon portefeuille' (wallet), 'J'ai perdu mon passeport' (passport). 'J'ai perdu' = I lost (passé composé of perdre).")]),

  mkL("a1-25","Hobbies & Free Time",20,"speaking",
    "Talk about your interests in French! Common hobbies: lire (read), écrire (write), cuisiner/faire la cuisine (cook), regarder des films (watch movies), écouter de la musique (listen to music), faire du sport (play sports), jouer aux jeux vidéo (play video games), jardiner (garden), voyager (travel), faire des randonnées (hike), jouer d'un instrument (play an instrument).",
    ["J'aime + infinitif (I like to...)","Je préfère (I prefer)","lire (read)","cuisiner (cook)","faire du sport (play sports)","écouter de la musique","regarder des films","jouer aux cartes/échecs","le weekend, je...","pendant mon temps libre (in my free time)"],
    [mcq("'J'aime faire de la randonnée' means:",["I like watching movies","I like hiking","I like swimming","I like cooking"],1,"Faire de la randonnée = to hike/go hiking. 'Faire de' + activity is common: faire du vélo (cycling), faire de la natation (swimming), faire du yoga, faire de la cuisine. Very natural French!"),
     mcq("'Qu'est-ce que vous faites pendant votre temps libre?' asks:",["What do you do for work?","What are you doing right now?","What do you do in your free time?","What time is it?"],2,"Pendant votre temps libre = in your free time. 'Qu'est-ce que vous faites' = what do you do/are you doing. A great conversation starter in Canada — showing interest in hobbies builds relationships!"),
     wr("Say what you like to do on weekends",["le weekend j'aime","le week-end je","le samedi je","le dimanche j'aime"],"Le weekend, j'aime [activity] — perfect! Or: 'Pendant mon temps libre, j'aime cuisiner et lire.' Talking about hobbies is a core part of CLB speaking tasks — be ready to describe yours for 1-2 minutes!")]),

  mkL("a1-26","Weather & Canadian Seasons (Full)",20,"speaking",
    "Canada's weather is dramatic and a constant conversation topic! Describing weather: Il fait chaud/froid/beau/mauvais, Il pleut/neige/grêle (hails), Il y a du soleil/du brouillard (fog)/du verglas (black ice)/une tempête (storm). Clothing advice: 'Habille-toi chaudement!' (Dress warmly!), 'Prends ton parapluie' (Take your umbrella). Winter driving: 'Les routes sont glissantes' (Roads are slippery).",
    ["Il pleut (it's raining)","Il neige (it's snowing)","Il grêle (it's hailing)","Il y a du verglas (black ice)","Il y a du brouillard (fog)","une tempête de neige (snowstorm)","la météo (weather forecast)","Il fait combien? (What's the temperature?)","Les routes sont glissantes (roads are slippery)"],
    [mcq("'Il y a du verglas ce matin' means:",["It's raining hard this morning","There's black ice this morning","It's very windy this morning","There's fog this morning"],1,"Du verglas = black ice — extremely important in Canada! Winter driving on black ice is dangerous. 'Soyez prudents, il y a du verglas sur les routes' = Be careful, there's black ice on the roads. A news headline you'll hear every winter!"),
     mcq("'Prends ton manteau — il fait -15°C!' means:",["Take your umbrella — it's -15°C!","Take your coat — it's -15°C!","Stay inside — it's -15°C!","Drive carefully — it's -15°C!"],1,"Prends ton manteau = take your coat. Le manteau = winter coat (essential in Canada!). -15°C is a typical Quebec winter day — layers are mandatory: manteau, foulard (scarf), gants (gloves), tuque (winter hat — a Quebec word used across Canada!)."),
     wr("Describe today's weather in French",["il fait","il pleut","il neige","il y a du","c'est","il fait froid","il fait beau"],"Il fait beau aujourd'hui! / Il pleut ce matin. / Il neige beaucoup! — any of these work. Start conversations with weather in Canada — it's literally the #1 small talk topic! 'Quel temps horrible!' (What awful weather!) is always relatable in winter!")]),

  mkL("a1-27","A1 Grammar Review: Verbs",25,"integrated",
    "Review session: all major A1 verb types and forms. être and avoir (essential irregular), -ER verbs (80% of verbs), -IR regular verbs, key irregular verbs (faire, aller, venir, pouvoir, vouloir, devoir), reflexive verbs for daily routine, near future (aller + inf), negation (ne...pas, ne...jamais, ne...plus). If you can use these fluently, you're at A1/CLB 2 level!",
    ["Review: être/avoir all forms","Review: -ER verb conjugation","Review: pouvoir/vouloir/devoir + infinitif","Review: réflexifs (se lever, se coucher)","Review: aller + infinitif (near future)","Review: ne...pas, ne...jamais, ne...plus","Diagnostic: 5 quick questions"],
    [mcq("'Nous ___ partir à 8h.' (We have to leave at 8.)",["allons","voulons","devons","pouvons"],2,"Nous devons = we have to/must. Devoir + infinitif = obligation. 'Nous devons partir à 8h pour ne pas rater le bus' = We have to leave at 8 so we don't miss the bus."),
     mcq("'Je ne travaille ___' means I don't work anymore:",["pas","jamais","rien","plus"],3,"Ne...plus = no longer/anymore. 'Je ne travaille plus' = I don't work anymore (I used to, but I stopped). Ne...jamais = never, ne...rien = nothing, ne...pas = basic negation."),
     mcq("'Elle va ___ le médecin demain.' (She's going to see the doctor.)",["voir","voit","voit","voyant"],0,"Elle va voir le médecin — aller + infinitif. 'Voir' (to see) is the infinitive. Near future: je vais, tu vas, il/elle va + infinitif. Always use the INFINITIVE form after aller!"),
     wr("Conjugate 'se lever' for 'nous'",["nous nous levons"],"Nous nous levons — both the verb (levons) and the reflexive pronoun (nous) are needed! 'Nous nous levons' = we get up. The doubled 'nous' looks strange but is correct and essential for reflexive verbs in plural forms.")]),

  mkL("a1-28","A1 Vocabulary Review: Daily Life",25,"integrated",
    "Vocabulary checkpoint! This session covers the 500 most important A1 words across all themes. Key categories: greetings/politeness, numbers/time, family, house, food, transport, health, work, shopping, school, emotions. A true A1 speaker knows these words reflexively — no hesitation needed.",
    ["Révision: greetings and politeness","Révision: numbers, time, dates","Révision: family and description","Révision: house and neighborhood","Révision: food and restaurant","Révision: transport and directions","Révision: health and body","Révision: work and services"],
    [mcq("'La pharmacie est ouverte jusqu'à 22h' means:",["The pharmacy opens at 10pm","The pharmacy is open until 10pm","The pharmacy closes at 10am","The pharmacy opened at 10pm"],1,"Jusqu'à = until. 'Ouverte jusqu'à 22h' = open until 10pm. 'Ouvert de 9h à 22h' = open from 9am to 10pm. Essential for checking service hours in Canada — many pharmacies are open late!"),
     mcq("'Mon loyer est de 950$ par mois' — what are you talking about?",["your salary","your rent","your mortgage","your bills"],1,"Le loyer = rent. 'Mon loyer' = my rent. '$950 par mois' = $950 per month. Housing costs are a major topic for newcomers — knowing this vocabulary helps you navigate ads, leases, and landlord communication!"),
     wr("Name 3 things you do every morning (routine)",["je me réveille","je me lève","je me douche","je mange","je prends","je vais"],"Morning routine answers: Je me réveille, je me lève, je me douche, je m'habille, je mange, je prends le bus. This is a standard CLB 4 speaking task — practice until fluent!")]),

  mkL("a1-29","A1 Speaking Practice: Introductions",20,"speaking",
    "SPEAKING ASSESSMENT — Introduce yourself fully in French! A complete A1 introduction covers: name (Je m'appelle...), age (J'ai X ans), origin (Je viens de... / Je suis [nationality]), current city (J'habite à...), profession or student status (Je suis.../Je travaille comme...), family (J'ai X enfants / Je suis marié(e)), hobbies (J'aime...), French level (J'apprends le français depuis X mois/ans). Practice until automatic!",
    ["Je m'appelle... (name)","J'ai ... ans (age)","Je viens de... (origin)","J'habite à... (city)","Je suis / Je travaille comme... (profession)","J'ai X enfants / Je suis marié(e)","J'aime + activité (hobbies)","J'apprends le français depuis..."],
    [mcq("A complete A1 introduction in French should include:",["only name and age","name, age, origin, current city, and one detail about yourself","name and profession only","name, age, and a long life story"],1,"Name + age + origin + city + at least one personal detail = complete A1 introduction. This is asked in CLB 3-4 speaking assessments! Practice delivering this in 30-60 seconds without hesitation."),
     mcq("'J'apprends le français depuis 8 mois' tells people:",["you finished learning French 8 months ago","you've been learning French for 8 months (ongoing)","you'll learn French for 8 months","you learned French 8 months ago"],1,"Depuis + présent = ongoing! 'J'apprends depuis 8 mois' = I've been learning for 8 months (and I'm still learning). Shows humility and real effort — Canadians always appreciate this!"),
     wr("Write your full introduction in French (all 6 elements)",["je m'appelle","j'ai","je viens","j'habite","je suis","j'aime"],"Je m'appelle [name], j'ai [X] ans. Je viens de [country] et j'habite à [city]. Je suis/travaille comme [profession]. J'ai/Je suis [family status]. J'aime [hobby]. J'apprends le français depuis [time]. — Perfect complete A1 introduction!")]),

  mkL("a1-30","A1 Writing Practice: Short Messages",25,"writing",
    "Writing assessment: CLB 3 requires writing short, functional messages. Practice these 4 types: 1) Text message to a friend (informal), 2) Note to a neighbor, 3) Email to cancel an appointment (formal), 4) Short form completion. Key: in informal messages use 'tu', in formal use 'vous'. Always: clear purpose, enough detail, polite closing.",
    ["SMS/texto (informal, tu)","Note pour voisin (semi-formal)","Courriel pour annuler (formal, vous)","Remplir un formulaire","Formules d'ouverture/fermeture","Contenu: qui, quoi, quand, où, pourquoi","Correction des erreurs fréquentes"],
    [mcq("An informal text to a friend about being late:",["Bonjour Monsieur, je serai en retard. Cordialement.","Salut! Je vais être en retard de 10 minutes. Désolé(e)!","Je vous informe que je serai en retard.","Cher ami, je suis dans l'impossibilité d'arriver à l'heure."],1,"'Salut! Je vais être en retard de 10 minutes. Désolé(e)!' — perfect informal text! Salut, tu-form implied, brief, apologetic. A formal version would start with 'Bonjour' and use 'vous'. Context determines register!"),
     mcq("A formal email cancelling a doctor's appointment should open with:",["Allo docteur!","Hey, je peux pas venir","Bonjour Docteur Martin,","Salut, je dois annuler"],2,"Bonjour Docteur Martin, — formal, uses title and name. Then: 'Je vous écris pour vous informer que je dois malheureusement annuler mon rendez-vous du [date].' Always give a brief reason and offer to reschedule!"),
     wr("Write a 2-line note to your neighbor about noise",["je suis désolé(e)","bonsoir","bonjour","excusez-moi","je voulais vous informer","le bruit"],"Sample: 'Bonsoir, je suis désolé(e) pour le bruit de ce soir. Cordialement, [Name] (appartement 3B).' Brief, polite, explains the situation, and signs off professionally. Perfect A1/CLB 3 writing!")]),

  // Lessons 31-40: Grammar expansion
  mkL("a1-31","Possessives & Demonstratives Review",20,"reading",
    "Consolidation session for possessives and demonstratives with tricky cases! Remember: possessives agree with the NOUN (not the owner). Son/sa/ses = his OR her. 'Son médecin' = his/her doctor. 'Sa voiture' = his/her car. Demonstratives: ce/cet/cette/ces = this/that/these/those. Special case: 'cet' before masculine vowel/H. Adding -ci/-là specifies this vs that.",
    ["mon/ma/mes, ton/ta/tes, son/sa/ses","notre/nos, votre/vos, leur/leurs","son = his OR her (depends on context)","ce + m. consonant, cet + m. vowel/H","cette + f., ces + plural","ce rendez-vous-ci (this appointment)","ce rendez-vous-là (that appointment)"],
    [mcq("'___ ami(e) s'appelle Laure.' (My friend's name is Laure.)",["Ma","Mon","Mes","Mes"],1,"Mon ami — even though 'amie' is feminine, 'ami' starts with a vowel! Before any vowel sound, use MON (not MA): mon amie, mon école, mon histoire. This prevents the awkward 'ma amie' sound!"),
     mcq("'C'est ___ appartement.' (It's their apartment.) [plural they]",["sa","son","leur","leurs"],2,"Leur appartement — 'leur/leurs' = their (plural owners). 'Leur' before singular noun, 'leurs' before plural: leur appartement, leurs enfants. Don't confuse with 'lui' (him, indirect pronoun)!"),
     wr("Write 'this hospital appointment' in French",["ce rendez-vous à l'hôpital","cet rendez-vous","ce rendez-vous"],"Ce rendez-vous — 'rendez-vous' starts with R (consonant) → CE (not CET). If starting with vowel: cet hôpital (this hospital). Adding -ci/-là: 'ce rendez-vous-ci' (this specific appointment here).")]),

  mkL("a1-32","Comparatives & Superlatives",20,"reading",
    "Compare things in French! Comparatives: plus...que (more...than), moins...que (less...than), aussi...que (as...as). Examples: 'Montréal est plus grand que Québec' (Montreal is bigger than Quebec City). Superlatives: le/la/les plus + adj (the most), le/la/les moins + adj (the least). Irregular: bon→meilleur (better/best), mauvais→pire (worse/worst), bien→mieux (better/best — adverb).",
    ["plus + adj + que (more...than)","moins + adj + que (less...than)","aussi + adj + que (as...as)","le/la plus + adj (the most)","le/la moins + adj (the least)","meilleur/meilleure (better/best)","pire (worse/worst)","mieux (better — adverb)"],
    [mcq("'Le français est plus difficile que l'espagnol pour moi.' means:",["French is less difficult than Spanish for me","French is as difficult as Spanish for me","French is more difficult than Spanish for me","French is the most difficult language for me"],2,"Plus + adj + que = more...than. 'Plus difficile que' = more difficult than. For comparative, remember: plus, moins, aussi — followed by que!"),
     mcq("'C'est la meilleure pharmacie du quartier.' means:",["It's a good pharmacy","It's a better pharmacy","It's the best pharmacy in the neighborhood","It's the worst pharmacy"],2,"Meilleure = best (feminine of meilleur). Superlative: le/la meilleur(e) = the best. 'Du quartier' = of/in the neighborhood. Irregular: bon→meilleur, mauvais→pire. Don't say 'le plus bon' — always 'le meilleur'!"),
     wr("Say 'French is as important as English in Canada'",["le français est aussi important que l'anglais au canada","le francais est aussi important que l'anglais"],"Le français est aussi important que l'anglais au Canada — aussi...que = as...as (equality). A true statement about Canada's bilingualism! 'Aussi' can be used with adjectives AND adverbs: 'Je parle aussi vite que toi.'")]),

  mkL("a1-33","Object Pronouns: Le, La, Les",25,"writing",
    "Direct object pronouns replace nouns after verbs! Le (replaces masculine singular noun), La (feminine singular), Les (plural). They go BEFORE the verb in French! Je mange le pain → Je le mange. Elle appelle la docteure → Elle l'appelle. Ils font les devoirs → Ils les font. With infinitives: aller chercher les enfants → aller les chercher.",
    ["le (replaces m. singular noun)","la (replaces f. singular noun)","l' (before vowel/H)","les (replaces plural noun)","pronoun BEFORE the verb!","negative: je ne le comprends pas","infinitive: je vais l'appeler"],
    [mcq("'Tu connais ce médecin?' 'Oui, je ___ connais.'",["le","la","les","lui"],0,"Je le connais — 'ce médecin' is masculine singular → le. Pronouns go before the verb: je LE connais (not je connais le). This is one of the most important structural differences from English!"),
     mcq("'Est-ce que tu as la carte-santé?' 'Non, je ne ___ ai pas.'",["le","la","les","lui"],1,"Je ne LA ai pas → Je ne l'ai pas (elision!). La = replaces 'la carte-santé' (feminine). In negation: ne + pronoun + verb + pas. 'Je ne l'ai pas trouvée' = I didn't find it (feminine agreement in passé composé with direct object pronoun!)"),
     wr("Replace the object: 'Elle regarde les documents' (She looks at the documents.)",["elle les regarde"],"Elle les regarde — 'les documents' (plural) → les. Always BEFORE the verb! If you're taking the CLB test: 'Avez-vous rempli les formulaires?' 'Oui, je les ai remplis.' (pronoun + agreement in passé composé!)")]),

  mkL("a1-34","Prepositions with Cities & Countries",20,"reading",
    "This rule is tested everywhere in Canada! Cities: always À. À Montréal, à Ottawa, à Paris. Countries and regions: EN + feminine countries (en France, en Algérie, en Ontario). AU + masculine countries (au Canada, au Maroc, au Japon). AUX + plural countries (aux États-Unis, aux Philippines). DE/D' for coming from: je viens de France, je viens du Canada, je viens des États-Unis.",
    ["à + ville (à Montréal)","en + pays féminin (en France)","au + pays masculin (au Canada)","aux + pays pluriel (aux États-Unis)","de + pays féminin (de France)","du + pays masculin (du Canada)","des + pays pluriel (des États-Unis)","en + province québécoise (en Ontario, en Colombie-Britannique)"],
    [mcq("'Je vais ___ États-Unis la semaine prochaine.'",["à","en","au","aux"],3,"Aux États-Unis — États-Unis is plural (the United States). Les États-Unis → aux États-Unis. De → des États-Unis. Always: aux and des with plural country names!"),
     mcq("'Elle vient ___ Algérie.' (She comes from Algeria.)",["du","de","d'","des"],2,"D'Algérie — Algérie starts with A (vowel) → d' (elision of de). 'De l'Algérie' is technically correct too but 'D'Algérie' is more natural. Feminine country → de/d'. Je viens d'Algérie, de France, du Maroc."),
     wr("Say 'I'm going to Quebec City next month'",["je vais à québec le mois prochain","je vais à québec city le mois prochain","je vais à québec prochain mois"],"Je vais à Québec le mois prochain — 'à + city' always! Important: Québec the city vs le Québec the province. 'J'habite en Colombie-Britannique mais je vais à Québec le mois prochain.'")]),

  mkL("a1-35","Expressing Likes & Dislikes",20,"speaking",
    "Express preferences in French! Loving: j'adore, je suis passionné(e) par. Liking: j'aime (bien), j'apprécie. Neutral: ça me plaît (I like it), c'est correct. Disliking: je n'aime pas (tellement), je n'apprécie pas. Hating: je déteste, je ne supporte pas. Preference: je préfère X à Y. Discovering: j'ai découvert que, j'ai appris à aimer. Opinion: je trouve que, je pense que.",
    ["j'adore (I love)","j'aime (bien) (I like)","j'apprécie (I appreciate)","je n'aime pas (I don't like)","je déteste (I hate)","je préfère X à Y (I prefer X to Y)","ça me plaît (I like it — more specific)","Qu'est-ce que tu aimes faire? (What do you like to do?)"],
    [mcq("'Je préfère le thé au café' means:",["I like tea and coffee","I prefer tea to coffee","I hate tea and coffee","I drink both tea and coffee"],1,"Je préfère X à Y = I prefer X to Y. 'Au café' = à + le café. 'Je préfère le thé au café, mais je prends un café le matin quand même!' A very natural preference statement!"),
     mcq("'J'adore' is stronger than 'j'aime'. Which is strongest?",["j'aime bien","j'apprécie","j'adore","j'aime"],2,"Scale: je déteste < je n'aime pas < ça m'est égal < j'aime bien < j'aime < j'apprécie < j'adore. 'J'adore le français!' is stronger than 'J'aime le français.' Use adore for things you're passionate about!"),
     wr("Say what you love and hate about Canadian winter",["j'adore","j'aime","je déteste","je n'aime pas","je préfère"],"Sample: 'J'adore la neige mais je déteste le froid extrême. Je préfère l'automne à l'hiver.' — expressing mixed opinions shows B1-level nuance! Practice using contrast words like 'mais' and 'cependant'.")]),

  mkL("a1-36","A1 Listening Practice: Understanding Instructions",20,"listening",
    "Practice understanding spoken French for daily Canadian life! Common instruction contexts: transit announcements, voicemail messages, doctor's instructions, workplace directives, school communications. Key strategy: focus on key NOUNS and VERBS, don't panic about words you don't know, use context to guess unfamiliar vocabulary. Numbers, names, and times are priority listening targets.",
    ["Stratégie: écouter les mots-clés","Numéros, noms, heures = priorité","Context = guess unknown words","Message téléphonique (voicemail)","Annonce de transport (transit)","Instructions médicales","À prendre matin et soir (take morning and evening)","Prenez un comprimé par jour (one tablet per day)"],
    [mcq("In a pharmacy voicemail, you hear 'deux fois par jour'. This means take the medication:",["twice a week","twice a day","two at a time","for two days"],1,"Deux fois par jour = twice a day (literally 'two times per day'). Medical dosing vocabulary: une fois par jour (once daily), deux fois par jour (twice daily), toutes les 8 heures (every 8 hours). Always listen carefully to dosage instructions!"),
     mcq("A transit announcement says 'Le prochain bus arrive dans cinq minutes.' This means:",["The bus left 5 minutes ago","The next bus arrives in 5 minutes","The bus is 5 minutes late","The bus comes every 5 minutes"],1,"Dans cinq minutes = in five minutes (from now). 'Il y a cinq minutes' = five minutes ago (in the past). 'Pendant cinq minutes' = for five minutes. These distinctions are tested in CLB 4 listening!"),
     wr("Write what 'Prenez un comprimé avec de l'eau le matin' means",["take one tablet with water in the morning","prendre un comprimé avec de l'eau le matin"],"Prenez un comprimé avec de l'eau le matin = Take one tablet with water in the morning. Medical instructions you'll receive at any Canadian pharmacy. 'Comprimé' = tablet/pill. 'Avec de l'eau' = with water.")]),

  mkL("a1-37","A1 Writing: Filling Forms",20,"writing",
    "Canadian forms require specific French vocabulary! Key fields: Nom de famille (last name), Prénom(s) (first name[s]), Date de naissance (DOB — day/month/year in Canada), Sexe (sex: M/F), Adresse complète (full address — numéro, rue, ville, province, code postal), Numéro de téléphone, Courriel, Numéro d'assurance maladie (health insurance number — RAMQ in Quebec), Signature.",
    ["Nom de famille (last name)","Prénom(s) (first name)","Date de naissance (JJ/MM/AAAA)","Adresse complète","Code postal (A1A 1A1 format)","Numéro d'assurance maladie","Statut matrimonial (marital status)","Nationalité/Citoyenneté","Signature obligatoire"],
    [mcq("On a Quebec form, 'Numéro d'assurance maladie' refers to:",["your SIN number","your RAMQ health card number","your passport number","your employee number"],1,"Numéro d'assurance maladie = your RAMQ (health insurance) card number. RAMQ = Régie de l'assurance maladie du Québec. You'll need this at EVERY healthcare appointment in Quebec. Keep it memorized!"),
     mcq("Canadian dates are written in the format:",["MM/DD/YYYY","DD/MM/YYYY","YYYY/MM/DD","MM-YYYY-DD"],1,"In Canada: DD/MM/YYYY (day/month/year) is used on French forms — same as France and most of the world! But English Canada often uses MM/DD/YYYY. When filling French forms: 15/03/2025 = March 15, 2025."),
     wr("Write your full address in proper French format",["numéro","rue","appartement","ville","province","code postal"],"Format: [number] [street], Appartement [X], [City], [Province], [Postal Code]. Example: 1234, rue Saint-Denis, Appartement 5, Montréal, Québec, H2J 2K5. Every element is needed for official Canadian mail!")]),

  mkL("a1-38","A1 Integrated Practice",25,"integrated",
    "Integrated A1 practice covering all skills! This session simulates the kind of multi-skill tasks you'll face in CLB 3-4 assessments. Reading a short notice, answering comprehension questions, writing a short response, and demonstrating grammar knowledge. This is what CLB test preparation looks like at A1 level.",
    ["Comprendre une courte annonce","Répondre à des questions de compréhension","Rédiger une réponse courte","Utiliser les temps et la grammaire A1","Vocabulaire en contexte réel"],
    [mcq("Notice: 'Le cabinet médical sera fermé le lundi 12 janvier pour cause de formation du personnel.' What is closed?",["The hospital","The medical office","The pharmacy","The school"],1,"Le cabinet médical = the medical office/clinic. 'Sera fermé' = will be closed (future tense!). 'Pour cause de' = due to/because of. 'Formation du personnel' = staff training. Notice reading is a core CLB 4 task!"),
     mcq("'Pour cause de formation' tells you the office is closed because of:",["a public holiday","a patient shortage","staff training","bad weather"],1,"Pour cause de = due to/because of. 'Formation du personnel' = staff training. This type of explanation appears in all official notices. Other common reasons: travaux (construction/repairs), congé (holiday)."),
     wr("Write a 2-sentence response to rescheduling your appointment",["je dois reporter","je voudrais reporter","je confirme","quand êtes-vous disponible","quel jour","disponibilité"],"'Suite à la fermeture du cabinet le 12 janvier, je dois reporter mon rendez-vous. Seriez-vous disponible la semaine du 19 janvier?' — Professional, clear, uses conditional for politeness. Perfect CLB 3-4 writing!")]),

  mkL("a1-39","A1 Speaking Assessment Prep",20,"speaking",
    "Final speaking preparation for A1/CLB 3-4! You should now be able to: ✓ Introduce yourself fully (1 minute), ✓ Describe your daily routine, ✓ Talk about your family, ✓ Ask and answer simple questions, ✓ Handle basic service interactions (pharmacy, store, clinic), ✓ Describe a simple problem, ✓ Express preferences. Practice speaking each of these out loud — fluency comes from repetition!",
    ["Auto-présentation (self-introduction — 60 sec)","Routine quotidienne (daily routine — 60 sec)","Famille et logement (family/housing)","Situation professionnelle (work)","Demande de service (service request)","Exprimer un problème simple","Exprimer une préférence","Questions fréquentes de CLB 3-4"],
    [mcq("A CLB 3-4 speaking task asks you to describe your daily routine. You should speak for:",["5-10 seconds","10-20 seconds","30-60 seconds","3-5 minutes"],2,"CLB 3-4 = 30-60 seconds on familiar topics. Use: D'abord, ensuite, puis, après, finalement. Include times (à 7h, le matin), specific activities (je prends le bus), and at least 2-3 sequence connectors!"),
     mcq("If you don't understand a question in a CLB speaking test, you should:",["Stay silent","Say 'I don't know' in English","Say 'Pouvez-vous répéter la question, s'il vous plaît?'","Leave the room"],2,"'Pouvez-vous répéter la question, s'il vous plaît?' — Always ask in FRENCH! This itself demonstrates language competency. Assessors respect when learners ask for clarification — it's a real communication skill."),
     wr("Practice your full 60-second self-introduction",["je m'appelle","j'ai","je viens","j'habite","je travaille","je suis","j'aime","j'apprends le français"],"Perfect! Your A1 introduction should cover all 6 elements in under 60 seconds. If you can deliver this smoothly, you're ready for CLB 3 speaking. Practice 5 times out loud right now!")]),

  mkL("a1-40","A1 Final Assessment",30,"integrated",
    "Congratulations on completing A1! This final assessment checks your mastery of all A1 content. You're ready for A2 if you can: conjugate être, avoir, -ER, -IR, and key irregular verbs correctly, form negatives and questions, use possessives and demonstratives, express near future, talk about daily life, health, work, housing, and shopping — all in complete sentences. Félicitations!",
    ["Test final A1 — toutes les compétences","Grammaire: verbes, articles, pronoms","Vocabulaire: vie quotidienne complète","Compréhension: annonce simple","Production: phrase complète et correcte","Vous êtes prêt(e) pour A2!"],
    [mcq("'Nous allons déménager au Québec l'année prochaine.' means:",["We moved to Quebec last year","We are going to move to Quebec next year","We should move to Quebec next year","We moved to Quebec this year"],1,"Allons déménager = near future (going to move). 'L'année prochaine' = next year. Déménager = to move (home/city). Perfectly formed A1 sentence showing near future + location preposition!"),
     mcq("Choose the CORRECT sentence:",["Je suis 30 ans","Je n'ai pas une voiture","Je vais à l'hôpital","Je habite à Montréal"],2,"Je vais à l'hôpital ✓. Errors: 'Je suis 30 ans' → J'ai 30 ans. 'Je n'ai pas une voiture' → Je n'ai pas DE voiture. 'Je habite' → J'habite (elision required before vowel)!"),
     wr("Write 3 correct French sentences about yourself using A1 grammar",["je","j'","j'ai","je suis","je vais","j'habite","je travaille","je m'appelle"],"Any 3 correct sentences: 'J'habite à Toronto depuis 2 ans. Je travaille comme technicien. Le weekend, j'aime faire du sport.' — If all 3 are grammatically correct, you're A1 certified! You've completed the A1 level. À vous l'A2!")])
];

// ─────────────────────────────────────────────────────────────────────────────
// A2 — 40 LESSONS (shortened for file size, but full structure)
// ─────────────────────────────────────────────────────────────────────────────
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
  return <button onClick={onClick} disabled={disabled} style={{padding:"13px 24px",borderRadius:13,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:disabled?"default":"pointer",opacity:disabled?0.45:1,display:"inline-flex",alignItems:"center",gap:8,transition:"all 0.2s",...base,...style}}>{children}</button>;
}

function Card({children,style={},onClick}){
  const[h,setH]=useState(false);
  return <div onClick={onClick} onMouseEnter={()=>setH(!!onClick)} onMouseLeave={()=>setH(false)} style={{background:T.card,borderRadius:20,padding:"22px 24px",boxShadow:"0 2px 8px rgba(0,0,0,0.04),0 12px 32px rgba(13,27,62,0.08)",transition:"all 0.2s",...(h?{transform:"translateY(-2px)",boxShadow:"0 4px 16px rgba(0,0,0,0.06),0 16px 40px rgba(13,27,62,0.12)"}:{}),...(onClick?{cursor:"pointer"}:{}),...style}}>{children}</div>;
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
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:900,color:"#fff",lineHeight:1.2}}>Unlock Franco Premium</div>
        <div style={{color:"rgba(255,255,255,0.75)",fontSize:13,marginTop:6}}>"{lessonTitle}" is a premium lesson</div>
      </div>

      {/* Price */}
      <div style={{padding:"20px 28px 0",textAlign:"center"}}>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:4}}>
          <span style={{fontFamily:"'Playfair Display',serif",fontSize:42,fontWeight:900,color:T.navy}}>$49</span>
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
        <button onClick={handleUpgrade} style={{width:"100%",padding:"16px",background:`linear-gradient(135deg,${T.blue},${T.navy})`,color:"#fff",border:"none",borderRadius:14,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:16,cursor:"pointer",boxShadow:`0 4px 20px ${T.blue}50`}}>
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
      <div style={{fontFamily:"'Playfair Display',serif",fontSize:34,fontWeight:900,color:"#fff",lineHeight:1.15}}>{s.title}</div>
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
        ?<button onClick={()=>setStep(s=>s+1)} style={{background:"#fff",color:T.navy,border:"none",padding:"16px 40px",borderRadius:16,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:16,cursor:"pointer",boxShadow:"0 8px 32px rgba(0,0,0,0.2)"}}>Next →</button>
        :<button onClick={onNext} style={{background:"linear-gradient(135deg,#10B981,#059669)",color:"#fff",border:"none",padding:"16px 40px",borderRadius:16,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:17,cursor:"pointer",boxShadow:"0 8px 32px rgba(16,185,129,0.4)"}}>Start Learning — Try Free! 🚀</button>}
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
      <div style={{fontFamily:"'Playfair Display',serif",fontSize:26,fontWeight:700,color:T.navy,marginBottom:8}}>Choose Your AI Teacher</div>
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
      <div style={{fontFamily:"'Playfair Display',serif",fontSize:26,fontWeight:700,color:T.navy,marginBottom:8}}>What's Your Current Level?</div>
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

function DashboardScreen({companion,startLevel,progress,onNavigate}){
  const level=SYLLABUS[startLevel]||SYLLABUS.foundation;
  const allL=Object.values(SYLLABUS).flatMap(l=>l.modules.flatMap(m=>m.lessons));
  const doneL=Object.keys(progress).length;
  const pct=Math.round((doneL/allL.length)*100);
  const xp=doneL*25;
  const totalXP=()=>{try{return parseInt(localStorage.getItem('franco_xp')||'0');}catch{return xp;}};
  const streak=()=>{try{return parseInt(localStorage.getItem('franco_streak')||'0');}catch{return 0;}};
  const skills=[{name:"Listening 🎧",pct:74,color:T.blue},{name:"Speaking 🗣",pct:58,color:T.mint},{name:"Writing ✍",pct:65,color:T.gold},{name:"Reading 📖",pct:81,color:T.purple}];
  return <div style={{padding:"28px 32px",maxWidth:1100,margin:"0 auto",display:"flex",flexDirection:"column",gap:20}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
      <div>
        <div style={{fontSize:13,color:T.textSoft,marginBottom:4}}>Good morning 👋</div>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:26,fontWeight:700,color:T.navy}}>Your French Journey</div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <Pill variant="gold">🔥 7 days</Pill>
        <Pill variant="blue">⭐ {xp} XP</Pill>
        <div style={{width:40,height:40,borderRadius:"50%",background:T.navy,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>{companion?.emoji||"👤"}</div>
      </div>
    </div>
    {/* Hero */}
    <div style={{background:`linear-gradient(135deg,${T.navy} 0%,#1A3280 60%,${T.blue} 100%)`,borderRadius:24,padding:28,color:"#fff",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:-40,right:-40,width:200,height:200,borderRadius:"50%",background:"rgba(255,255,255,0.03)"}}/>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:1.2,color:"rgba(255,255,255,0.6)",textTransform:"uppercase",marginBottom:8}}>Today's Mission</div>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,marginBottom:4}}>{level.label} — Continue Your Path</div>
          <div style={{fontSize:14,color:"rgba(255,255,255,0.65)"}}>{level.desc}</div>
        </div>
        <div style={{background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.2)",padding:"8px 14px",borderRadius:12,fontSize:13,fontWeight:600}}>{level.cefrTag} · {level.clbTag}</div>
      </div>
      <div style={{marginBottom:20}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:8,fontSize:13,color:"rgba(255,255,255,0.7)"}}>
          <span>Overall progress</span><span style={{color:"#fff",fontWeight:700}}>{pct}% · {doneL}/{allL.length} lessons</span>
        </div>
        <div style={{height:8,background:"rgba(255,255,255,0.15)",borderRadius:99,overflow:"hidden"}}>
          <div style={{height:"100%",width:`${pct}%`,background:"linear-gradient(90deg,#60A5FA,#93C5FD)",borderRadius:99,transition:"width 1s"}}/>
        </div>
      </div>
      <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
        {[{l:"▶️ Continue Learning",s:"hub",p:true},{l:"⚡ Practice",s:"practice"},{l:"📊 Progress",s:"profile"}].map(a=>(
          <button key={a.s} onClick={()=>onNavigate(a.s)} style={{background:a.p?"#fff":"rgba(255,255,255,0.1)",color:a.p?T.navy:"rgba(255,255,255,0.9)",border:a.p?"none":"1.5px solid rgba(255,255,255,0.2)",padding:"13px 22px",borderRadius:13,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer"}}>{a.l}</button>
        ))}
      </div>
    </div>
    {/* Stats */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
      {[{icon:"📅",label:"Lessons",val:doneL,sub:`of ${allL.length} total`},{icon:"🏆",label:"CLB Target",val:level.clbTag,sub:"current path"},{icon:"⭐",label:"XP Earned",val:totalXP(),sub:"all time"},{icon:"🔥",label:"Day Streak",val:streak(),sub:"keep going!"}].map((s,i)=>(
        <Card key={i}><div style={{fontSize:28,marginBottom:10}}>{s.icon}</div><div style={{fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:T.textSoft,marginBottom:8}}>{s.label}</div><div style={{fontFamily:"'Playfair Display',serif",fontSize:28,fontWeight:700,color:T.navy,marginBottom:4}}>{s.val}</div><div style={{fontSize:13,color:T.textSoft}}>{s.sub}</div></Card>
      ))}
    </div>
    {/* Skills + AI */}
    <div style={{display:"grid",gridTemplateColumns:"1.4fr 1fr",gap:16}}>
      <Card>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,fontWeight:700,color:T.navy,marginBottom:20}}>Skill Breakdown</div>
        {skills.map(sk=><div key={sk.name} style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontSize:14,fontWeight:600}}>{sk.name}</span>
            <span style={{fontSize:14,fontWeight:700,color:sk.color}}>{sk.pct}%</span>
          </div>
          <ProgressBar value={sk.pct} color={sk.color}/>
        </div>)}
      </Card>
      <Card style={{background:"linear-gradient(135deg,#EFF6FF,#F0FDF4)",border:`1.5px solid #C7D2FE`}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
          <Avatar companion={companion||COMPANIONS[0]} size={52}/>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:T.navy}}>{companion?.name||"Sophie"}</div>
            <div style={{fontSize:12,color:T.mint,fontWeight:600}}>● Active</div>
          </div>
        </div>
        <div style={{fontSize:14,color:T.textMid,lineHeight:1.6,fontStyle:"italic",padding:14,background:"rgba(255,255,255,0.6)",borderRadius:12,borderLeft:`3px solid ${T.blue}`,marginBottom:14}}>"{companion?.messages?.idle||"Ready to learn! Let's tackle your next lesson."}"</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}><Pill variant="blue">Practice Speaking</Pill><Pill variant="mint">Review Vocab</Pill></div>
      </Card>
    </div>
  </div>;
}

function HubScreen({progress,onStartLesson}){
  const[expanded,setExpanded]=useState(Object.keys(SYLLABUS)[0]);
  const[search,setSearch]=useState("");
  const totalXP=()=>{try{return parseInt(localStorage.getItem('franco_xp')||'0');}catch{return 0;}};
  const streak=()=>{try{return parseInt(localStorage.getItem('franco_streak')||'0');}catch{return 0;}};
  const allLessons=Object.values(SYLLABUS).flatMap(lv=>lv.modules.flatMap(m=>m.lessons));
  const doneLessons=allLessons.filter(l=>progress[l.id]);
  const nextLesson=allLessons.find(l=>!progress[l.id]);
  const nextLevel=Object.values(SYLLABUS).find(lv=>lv.modules.flatMap(m=>m.lessons).some(l=>!progress[l.id]));

  return <div style={{padding:"28px 32px",maxWidth:960,margin:"0 auto"}}>

    {/* Header banner */}
    <div style={{background:"linear-gradient(135deg,#0D1B3E 0%,#1A3280 50%,#1A56DB 100%)",borderRadius:24,padding:"28px 32px",marginBottom:24,color:"#fff",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:-40,right:-40,width:180,height:180,borderRadius:"50%",background:"rgba(255,255,255,0.05)"}}/>
      <div style={{position:"absolute",bottom:-60,right:60,width:240,height:240,borderRadius:"50%",background:"rgba(255,255,255,0.03)"}}/>
      <div style={{display:"flex",alignItems:"center",gap:20,flexWrap:"wrap",position:"relative"}}>
        <div style={{flex:1}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"rgba(255,255,255,0.5)",marginBottom:6}}>🍁 FRANCO — Learn French for Canada</div>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,marginBottom:4}}>{doneLessons.length} lessons complete — {allLessons.length-doneLessons.length} to go!</div>
          <div style={{fontSize:13,color:"rgba(255,255,255,0.7)"}}>Foundation → B2 · CLB 1–7 · TEF Canada prep · 190 lessons · 100% FREE 🎉</div>
        </div>
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          {[{icon:"⭐",val:totalXP()+" XP",lbl:"Total"},{icon:"🔥",val:streak()+" days",lbl:"Streak"},{icon:"📊",val:Math.round(doneLessons.length/allLessons.length*100)+"%",lbl:"Done"}].map(s=>
            <div key={s.lbl} style={{textAlign:"center",background:"rgba(255,255,255,0.1)",borderRadius:14,padding:"12px 16px",border:"1px solid rgba(255,255,255,0.15)"}}>
              <div style={{fontSize:18}}>{s.icon}</div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:700}}>{s.val}</div>
              <div style={{fontSize:10,color:"rgba(255,255,255,0.5)",textTransform:"uppercase",letterSpacing:.8}}>{s.lbl}</div>
            </div>)}
        </div>
      </div>
      {nextLesson&&nextLevel&&<div style={{marginTop:20,padding:"14px 18px",background:"rgba(255,255,255,0.1)",borderRadius:14,border:"1px solid rgba(255,255,255,0.15)",display:"flex",alignItems:"center",gap:14,position:"relative"}}>
        <span style={{fontSize:20}}>▶️</span>
        <div style={{flex:1}}>
          <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:2}}>CONTINUE WHERE YOU LEFT OFF</div>
          <div style={{fontSize:15,fontWeight:700}}>{nextLesson.title}</div>
          <div style={{fontSize:12,color:"rgba(255,255,255,0.6)"}}>{nextLevel.label} · {nextLesson.mins} min · starts easy!</div>
        </div>
        <button onClick={()=>onStartLesson(nextLesson,nextLevel)} style={{background:T.mint,color:"#fff",border:"none",padding:"10px 20px",borderRadius:12,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer"}}>Start Now →</button>
      </div>}
    </div>

    {/* Search bar */}
    <div style={{marginBottom:20,position:"relative"}}>
      <span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",fontSize:16}}>🔍</span>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search any lesson topic..." style={{width:"100%",padding:"12px 16px 12px 42px",borderRadius:14,border:`1.5px solid ${T.border}`,fontFamily:"'DM Sans',sans-serif",fontSize:14,color:T.text,background:T.card,outline:"none",boxSizing:"border-box"}}/>
      {search&&<button onClick={()=>setSearch("")} style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",fontSize:16,cursor:"pointer",color:T.textSoft}}>✕</button>}
    </div>

    {/* Search results */}
    {search.length>1&&<div style={{marginBottom:20}}>
      {(()=>{
        const q=search.toLowerCase();
        const results=allLessons.filter(l=>l.title.toLowerCase().includes(q)||l.teach?.toLowerCase().includes(q));
        const lv=(l)=>Object.values(SYLLABUS).find(lv=>lv.modules.flatMap(m=>m.lessons).some(x=>x.id===l.id));
        return results.length?results.slice(0,8).map(l=>{
          const level=lv(l); const done=!!progress[l.id];
          return <div key={l.id} onClick={()=>onStartLesson(l,level)} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",borderRadius:13,border:`1.5px solid ${done?T.mint:T.border}`,background:T.card,cursor:"pointer",marginBottom:8,transition:"all 0.2s"}}>
            <div style={{width:32,height:32,borderRadius:9,background:done?T.mint:level?.color||T.blue,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:13,fontWeight:700}}>{done?"✓":"▶"}</div>
            <div style={{flex:1}}><div style={{fontSize:14,fontWeight:600,color:T.navy}}>{l.title}</div><div style={{fontSize:11,color:T.textSoft}}>{level?.label} · {l.skill} · {l.mins} min</div></div>
            {done?<Pill variant="mint">Done</Pill>:<span style={{fontSize:12,color:T.blue,fontWeight:600}}>Go →</span>}
          </div>;
        }):<div style={{textAlign:"center",padding:"24px",color:T.textSoft,fontSize:14}}>No lessons found for "{search}" — try different keywords</div>;
      })()}
    </div>}
    {Object.values(SYLLABUS).map(level=>{
      const lLessons=level.modules.flatMap(m=>m.lessons);
      const donePct=Math.round((lLessons.filter(l=>progress[l.id]).length/lLessons.length)*100);
      const isOpen=expanded===level.id;
      return <Card key={level.id} style={{marginBottom:14,border:isOpen?`2px solid ${level.color}50`:`2px solid transparent`}}>
        <div onClick={()=>setExpanded(isOpen?null:level.id)} style={{display:"flex",alignItems:"center",gap:14,cursor:"pointer",marginBottom:isOpen?20:0}}>
          <div style={{width:48,height:48,borderRadius:14,background:`${level.color}15`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>{level.emoji}</div>
          <div style={{flex:1}}>
            <div style={{fontSize:16,fontWeight:700,color:T.navy,marginBottom:2}}>{level.label}</div>
            <div style={{fontSize:13,color:T.textSoft}}>{level.desc}</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:700,color:level.color}}>{donePct}%</div>
              <div style={{fontSize:11,color:T.textSoft}}>complete</div>
            </div>
            <div style={{display:"flex",gap:4}}><Pill style={{background:`${level.color}15`,color:level.color}}>{level.cefrTag}</Pill></div>
          </div>
          <div style={{fontSize:20,color:T.textSoft,transform:isOpen?"rotate(180deg)":"none",transition:"transform 0.3s"}}>⌄</div>
        </div>
        {isOpen&&<div>
          <ProgressBar value={donePct} color={level.color} style={{marginBottom:20}}/>
          {level.modules.map(mod=><div key={mod.id} style={{marginBottom:16}}>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:T.textSoft,marginBottom:10}}>📂 {mod.title}</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {mod.lessons.map((lesson,li)=>{
                const done=!!progress[lesson.id];
                const skillIcon={listening:"🎧",speaking:"🗣️",reading:"📖",writing:"✍️",integrated:"🔄"}[lesson.skill]||"📚";
                const isNext=!done&&mod.lessons.slice(0,li).every(l=>progress[l.id]);
                const locked=!isLessonFree(lesson.id)&&!isPremiumUnlocked();
                return <div key={lesson.id} onClick={()=>onStartLesson(lesson,level)} style={{display:"flex",alignItems:"center",gap:14,padding:"14px 16px",borderRadius:14,border:`1.5px solid ${done?level.color+"40":isNext&&!locked?level.color:locked?"#e2e8f0":T.border}`,background:done?`${level.color}07`:isNext&&!locked?`${level.color}04`:locked?"#f8fafc":T.card,cursor:"pointer",transition:"all 0.2s",position:"relative",overflow:"hidden",opacity:locked?0.75:1}}>
                  {isNext&&!done&&!locked&&<div style={{position:"absolute",top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,${level.color},${level.color}50)`}}/>}
                  <div style={{width:36,height:36,borderRadius:11,background:locked?"#e2e8f0":done?level.color:isNext?`${level.color}20`:T.surface,border:isNext&&!locked?`2px solid ${level.color}`:"none",display:"flex",alignItems:"center",justifyContent:"center",fontSize:done?14:16,color:done?"#fff":isNext?level.color:T.textSoft,fontWeight:700,flexShrink:0,transition:"all 0.2s"}}>{locked?"🔒":done?"✓":skillIcon}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:600,color:locked?"#94a3b8":T.navy,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{lesson.title}</div>
                    <div style={{fontSize:11,color:T.textSoft,marginTop:2,display:"flex",gap:8,alignItems:"center"}}>
                      <span>{lesson.skill}</span><span>·</span><span>{lesson.mins} min</span><span>·</span><span>{lesson.questions.length} questions</span>
                      {isNext&&!locked&&<span style={{color:level.color,fontWeight:700,fontSize:11}}>← Next up!</span>}
                      {locked&&<span style={{color:"#f59e0b",fontWeight:700,fontSize:11}}>⭐ Premium</span>}
                    </div>
                  </div>
                  {locked?<span style={{fontSize:11,background:"linear-gradient(135deg,#f59e0b,#ef4444)",color:"#fff",padding:"3px 8px",borderRadius:8,fontWeight:700,flexShrink:0}}>Unlock</span>:done?<Pill variant="mint" style={{fontSize:11}}>Done ✓</Pill>:isNext?<span style={{fontSize:12,color:level.color,fontWeight:700,flexShrink:0}}>Start →</span>:<span style={{fontSize:12,color:T.textSoft,flexShrink:0}}>→</span>}
                </div>;
              })}
            </div>
          </div>)}
        </div>}
      </Card>;
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
  const[phase,setPhase]=useState("teach");
  const[qIdx,setQIdx]=useState(0);
  const[selected,setSelected]=useState(null);
  const[writeVal,setWriteVal]=useState("");
  const[answered,setAnswered]=useState(false);
  const[correct,setCorrect]=useState(0);
  const[xp,setXp]=useState(0);
  const[showConfetti,setShowConfetti]=useState(false);
  const[streak,setStreak]=useState(()=>{try{return parseInt(localStorage.getItem('franco_streak')||'0');}catch{return 0;}});
  const[avatarText,setAvatarText]=useState(null);
  const[typing,setTyping]=useState(false);
  const[speaking,setSpeaking]=useState(false);
  const[orderPlaced,setOrderPlaced]=useState([]);
  const[orderBank,setOrderBank]=useState([]);
  const[speakDone,setSpeakDone]=useState(false);

  // Questions sorted easy-first to build confidence
  const sortedQuestions = [...lesson.questions].sort((a,b)=>(a.diff||2)-(b.diff||2));
  const q=sortedQuestions[qIdx];
  const total=sortedQuestions.length;

  const speak=(text)=>{
    setTyping(true);setSpeaking(true);
    setTimeout(()=>{setTyping(false);setAvatarText(text);},800);
    setTimeout(()=>setSpeaking(false),Math.min(text.length*40+800,4000));
  };

  useEffect(()=>{
    const isFoundation = lesson.id.startsWith('f-');
    const greet = isFoundation
      ? `Bienvenue! 🎉 I'm ${c.name} — your AI French coach. We start SUPER easy so you feel confident right away. You've got this!`
      : `${c.messages.idle} Questions go from easy → harder, so you always start with a win! 💪`;
    setTimeout(()=>speak(greet),300);
  },[]);

  useEffect(()=>{
    if(q?.type==="order"){
      const shuffled=[...q.words].sort(()=>Math.random()-.5);
      setOrderBank(shuffled);setOrderPlaced([]);
    }
  },[qIdx,q?.type]);

  const handleTeachDone=()=>{
    setPhase("questions");
    speak(`Great! Let's practice! ${total} question${total>1?"s":""} — starting easy! 💪`);
  };

  const diffLabel=(d)=>d<=1?"⭐ Very Easy":d===2?"⭐⭐ Easy":d===3?"⭐⭐⭐ Medium":d===4?"⭐⭐⭐⭐ Hard":"⭐⭐⭐⭐⭐ CLB Level";
  const diffColor=(d)=>d<=1?T.mint:d===2?"#22C55E":d===3?T.gold:d===4?"#F97316":T.red;

  const checkAnswer=()=>{
    if(answered)return;
    let ok=false;
    if(q.type==="tap"||q.type==="mcq"){ok=selected===q.correct;}
    else if(q.type==="fill"){ok=selected===q.correct;}
    else if(q.type==="order"){ok=orderPlaced.join(" ")===q.correct.join(" ");}
    else if(q.type==="write"){
      const v=writeVal.trim().toLowerCase().replace(/['']/g,"'");
      ok=q.accepted.some(a=>v.includes(a.toLowerCase())||a.toLowerCase().split(" ").every(w=>v.includes(w)));
    }
    else if(q.type==="speak"){ok=speakDone;}
    setAnswered(true);
    if(ok){setCorrect(x=>x+1);setXp(x=>x+(q.diff||1)*15);}
    speak(ok?`${c.messages.correct} ${q.explain}`:
            `${c.messages.wrong} ${q.explain}`);
  };

  const nextQ=()=>{
    if(qIdx<total-1){
      setQIdx(i=>i+1);setSelected(null);setWriteVal("");setAnswered(false);
      setSpeakDone(false);setOrderPlaced([]);
      const msgs = [
        "Great! Next one ✨","You're on a roll! 🔥","Keep it up! 💪",
        "Looking good! 🌟","Nice work! →","Almost there! 🏁"
      ];
      const encouragements = qIdx===0 ? "Perfect start! Here comes the next one 🎯" :
        qIdx+1===total-1 ? "Last question — you've nearly done it! 🏁" :
        msgs[qIdx % msgs.length];
      setTimeout(()=>speak(encouragements),400);
    } else {setPhase("done");speak(correct>=total*0.7?c.messages.complete:"Good effort! Every question you do is progress. Review the explanations and try again! 📚");}
  };

  const isOk=answered&&(
    q?.type==="tap"||q?.type==="mcq"||q?.type==="fill"?selected===q?.correct:
    q?.type==="order"?orderPlaced.join(" ")===q?.correct?.join(" "):
    q?.type==="write"?q?.accepted?.some(a=>writeVal.trim().toLowerCase().includes(a.toLowerCase())):
    speakDone
  );

  const placeWord=(word,idx)=>{if(answered)return;setOrderPlaced(p=>[...p,word]);setOrderBank(b=>{const n=[...b];n.splice(idx,1,"__used__");return n;});};
  const removeWord=(idx)=>{if(answered)return;const word=orderPlaced[idx];setOrderPlaced(p=>{const n=[...p];n.splice(idx,1);return n;});setOrderBank(b=>b.map(w=>w==="__used__"&&orderBank.indexOf("__used__")>-1?word:w));};

  return <div style={{display:"grid",gridTemplateColumns:"260px 1fr",minHeight:"calc(100vh - 64px)"}}>
    {/* Avatar Panel */}
    <div style={{background:`linear-gradient(170deg,${T.navy} 0%,#1A3280 50%,${T.blue} 100%)`,padding:"28px 18px",display:"flex",flexDirection:"column",alignItems:"center",gap:16,position:"sticky",top:64,height:"calc(100vh - 64px)",overflow:"hidden"}}>
      <button onClick={()=>{if(window.confirm("Leave this lesson? Your progress on this lesson will not be saved."))onBack();}}
        style={{alignSelf:"flex-start",background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",color:"rgba(255,255,255,0.85)",borderRadius:8,padding:"5px 12px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",marginBottom:4}}>
        ← Back
      </button>
      <div style={{fontSize:10,fontWeight:700,letterSpacing:1.2,textTransform:"uppercase",color:"rgba(255,255,255,0.5)"}}>AI Teacher</div>
      <Avatar companion={c} speaking={speaking} size={110} showWaves/>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"center"}}>
        {[c.name,level.cefrTag].map(t=><div key={t} style={{fontSize:10,fontWeight:700,padding:"4px 10px",borderRadius:50,background:"rgba(255,255,255,0.1)",color:"rgba(255,255,255,0.85)",border:"1px solid rgba(255,255,255,0.15)"}}>{t}</div>)}
      </div>
      <SpeechBubble text={avatarText} companion={c} typing={typing}/>
      {phase==="questions"&&<div style={{width:"100%",marginTop:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,color:"rgba(255,255,255,0.65)",fontSize:12}}>
          <span>Progress</span><span style={{color:"#fff",fontWeight:700}}>{qIdx+1}/{total}</span>
        </div>
        <div style={{height:7,background:"rgba(255,255,255,0.15)",borderRadius:99,overflow:"hidden"}}>
          <div style={{height:"100%",width:`${((qIdx+(answered?1:0))/total)*100}%`,background:"linear-gradient(90deg,#60A5FA,#34D399)",transition:"width 0.5s"}}/>
        </div>
        <div style={{marginTop:10,display:"flex",gap:5,justifyContent:"center",flexWrap:"wrap"}}>
          {lesson.questions.map((_,i)=><div key={i} style={{width:8,height:8,borderRadius:"50%",background:i<qIdx?T.mint:i===qIdx?"#fff":"rgba(255,255,255,0.2)",transition:"all 0.3s"}}/>)}
        </div>
        <div style={{marginTop:10,textAlign:"center",fontSize:11,color:"rgba(255,255,255,0.5)"}}>⭐ {xp} XP earned</div>
      </div>}
    </div>

    {/* Content */}
    <div style={{padding:28,display:"flex",flexDirection:"column",gap:18,overflowY:"auto"}}>
      {/* TEACH PHASE */}
      {phase==="teach"&&<>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <Pill variant="blue">📖 Lesson</Pill>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:21,fontWeight:700,color:T.navy}}>{lesson.title}</div>
          <Pill style={{background:`${level.color}20`,color:level.color}}>{level.cefrTag}</Pill>
        </div>
        <Card>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:T.textSoft,marginBottom:10}}>🎯 What You'll Learn</div>
          <div style={{fontSize:15,color:T.textMid,lineHeight:1.75,marginBottom:18,display:"flex",alignItems:"flex-start",gap:8}}>
            <span style={{flex:1}}>{lesson.teach}</span>
          </div>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:T.textSoft,marginBottom:10}}>📝 Key Vocabulary — click to flip!</div>
          <VocabFlipList vocab={lesson.vocab}/>
        </Card>
        <Card style={{background:"linear-gradient(135deg,#FFF7ED,#FEF3C7)",border:"1.5px solid #FCD34D"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
            <span style={{fontSize:20}}>🍁</span>
            <div style={{fontSize:14,fontWeight:700,color:T.navy}}>Canadian Context</div>
          </div>
          <div style={{fontSize:13,color:T.textMid,lineHeight:1.65}}>This lesson is designed for real Canadian life — the situations, vocabulary, and phrases used daily in Quebec, Ontario, and across Canada. Every example is practical and immediately useful.</div>
        </Card>
        {/* Activity type preview */}
        <div style={{background:"linear-gradient(135deg,#F0F4FF,#E8F0FE)",borderRadius:16,padding:"16px 20px",border:`1.5px solid ${T.border}`}}>
          <div style={{fontSize:11,fontWeight:700,color:T.textSoft,textTransform:"uppercase",letterSpacing:.8,marginBottom:12}}>📊 What you'll do in this lesson:</div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:12}}>
            {(()=>{
              const types=[...new Set(sortedQuestions.map(q=>q.type))];
              const icons={tap:"👆 Tap",mcq:"🎯 Choice",fill:"✏️ Fill",order:"🔀 Build",write:"✍️ Write",speak:"🎤 Speak"};
              return types.map(t=><span key={t} style={{fontSize:12,fontWeight:700,padding:"6px 13px",borderRadius:50,background:T.card,border:`1.5px solid ${T.border}`,color:T.navy}}>{icons[t]||t}</span>);
            })()}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:16,fontSize:13,color:T.textMid}}>
            <span>⏱ ~{lesson.mins} min</span>
            <span>❓ {total} questions</span>
            <span style={{color:T.mint,fontWeight:700}}>⭐ Starts easy!</span>
          </div>
        </div>
        <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          <Btn onClick={handleTeachDone} style={{padding:"15px 32px",fontSize:15}}>Start Practice Questions →</Btn>
          <div style={{fontSize:12,color:T.textSoft}}>AI-powered · CLB exam ready 🍁</div>
        </div>
      </>}

      {/* QUESTION PHASE */}
      {phase==="questions"&&q&&<>
        {/* Question header with progress */}
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div style={{fontSize:11,fontWeight:700,padding:"5px 12px",borderRadius:50,background:`${diffColor(q.diff||2)}18`,color:diffColor(q.diff||2),border:`1.5px solid ${diffColor(q.diff||2)}35`}}>{diffLabel(q.diff||2)}</div>
          <div style={{fontSize:12,color:T.textSoft}}>Question {qIdx+1} of {total}</div>
          {qIdx===0&&<div style={{fontSize:12,fontWeight:700,color:T.mint,padding:"3px 10px",borderRadius:50,background:T.mintLight}}>Easiest first! 😊</div>}
          <div style={{marginLeft:"auto"}}><Pill variant="blue">{q.type==="tap"?"👆 Tap":"mcq"===q.type?"🎯 Multiple Choice":"fill"===q.type?"✏️ Fill Blank":"order"===q.type?"🔀 Build Sentence":"speak"===q.type?"🎤 Speak":"✍️ Write"}</Pill></div>
        </div>

        {/* TAP type — easiest, just tap the translation */}
        {q.type==="tap"&&<>
          <Card>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:32,fontWeight:700,color:T.navy,textAlign:"center",padding:"20px 0 6px",letterSpacing:1,display:"flex",alignItems:"center",justifyContent:"center",gap:12}}>
              {q.fr}
              <SpeakBtn text={q.fr} size={22}/>
            </div>
            <div style={{textAlign:"center",fontSize:13,color:T.textSoft,marginBottom:20}}>What does this mean in English?</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              {q.opts.map((opt,i)=>{
                const isSel=selected===i,isC=answered&&i===q.correct,isW=answered&&isSel&&i!==q.correct;
                return <button key={i} disabled={answered} onClick={()=>setSelected(i)} style={{padding:"16px 14px",borderRadius:16,border:`2.5px solid ${isC?T.mint:isW?T.red:isSel?T.blue:T.border}`,background:isC?T.mintLight:isW?T.redLight:isSel?T.blueLight:T.card,cursor:answered?"default":"pointer",fontSize:15,fontWeight:600,color:isC?"#065F46":isW?"#991B1B":T.text,transition:"all 0.2s",boxShadow:isC?"0 0 0 3px rgba(16,185,129,0.15)":isSel?"0 0 0 3px rgba(26,86,219,0.15)":"none"}}>{isC?"✓ ":isW?"✗ ":""}{opt}</button>;
              })}
            </div>
          </Card>
        </>}

        {/* MCQ type */}
        {q.type==="mcq"&&<>
          <Card>
            <div style={{fontSize:18,fontWeight:700,color:T.navy,marginBottom:20,lineHeight:1.5,display:"flex",alignItems:"flex-start",gap:8}}>
            <span style={{flex:1}}>{q.prompt}</span>
            <SpeakBtn text={q.prompt} size={18}/>
          </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              {q.options.map((opt,i)=>{
                const isSel=selected===i,isC=answered&&i===q.correct,isW=answered&&isSel&&i!==q.correct;
                return <button key={i} disabled={answered} onClick={()=>setSelected(i)} style={{padding:"14px 16px",borderRadius:14,border:`2px solid ${isC?T.mint:isW?T.red:isSel?T.blue:T.border}`,background:isC?T.mintLight:isW?T.redLight:isSel?T.blueLight:T.card,cursor:answered?"default":"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:10,fontSize:14,fontWeight:500,color:T.text,transition:"all 0.2s"}}>
                  <span style={{width:26,height:26,borderRadius:8,background:isC?T.mint:isW?T.red:isSel?T.blue:T.surface,color:(isSel||isC||isW)?"#fff":T.textMid,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:11,flexShrink:0}}>{["A","B","C","D"][i]}</span>{opt}</button>;
              })}
            </div>
          </Card>
        </>}

        {/* FILL type */}
        {q.type==="fill"&&<>
          <Card>
            <div style={{fontSize:14,color:T.textSoft,marginBottom:12,fontWeight:600}}>Fill in the blank:</div>
            <div style={{fontSize:20,fontWeight:700,color:T.navy,marginBottom:20,lineHeight:1.6}}>
              {q.before} <span style={{display:"inline-block",minWidth:80,borderBottom:`3px solid ${answered?(isOk?T.mint:T.red):T.blue}`,padding:"2px 8px",color:answered?isOk?T.mint:T.red:T.blue,fontStyle:"italic"}}>{selected!==null?q.options[selected]:"___"}</span> {q.after}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9}}>
              {q.options.map((opt,i)=>{
                const isSel=selected===i,isC=answered&&i===q.correct,isW=answered&&isSel&&i!==q.correct;
                return <button key={i} disabled={answered} onClick={()=>setSelected(i)} style={{padding:"13px 16px",borderRadius:12,border:`2px solid ${isC?T.mint:isW?T.red:isSel?T.blue:T.border}`,background:isC?T.mintLight:isW?T.redLight:isSel?T.blueLight:T.card,cursor:answered?"default":"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:14,fontWeight:600,fontStyle:"italic",color:isC?"#065F46":isW?"#991B1B":T.text,transition:"all 0.2s"}}>{isC?"✓ ":isW?"✗ ":""}{opt}</button>;
              })}
            </div>
          </Card>
        </>}

        {/* ORDER type — drag/click to build sentence */}
        {q.type==="order"&&<>
          <Card>
            <div style={{fontSize:13,fontWeight:700,color:T.textSoft,marginBottom:8,textTransform:"uppercase",letterSpacing:.8}}>Arrange the words:</div>
            <div style={{minHeight:52,padding:"10px 12px",background:T.surface,borderRadius:12,border:`2px dashed ${answered?(isOk?T.mint:T.red):T.border}`,marginBottom:14,display:"flex",flexWrap:"wrap",gap:7,alignItems:"center"}}>
              {orderPlaced.length===0&&<span style={{color:T.textSoft,fontSize:13,fontStyle:"italic"}}>Click words below to build the sentence...</span>}
              {orderPlaced.map((w,i)=><button key={i} disabled={answered} onClick={()=>removeWord(i)} style={{padding:"7px 13px",borderRadius:50,background:answered?isOk?T.mint:T.red:T.blue,color:"#fff",border:"none",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:answered?"default":"pointer",transition:"all 0.2s"}}>{w}</button>)}
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:7}}>
              {orderBank.map((w,i)=>w==="__used__"?<div key={i} style={{padding:"7px 13px",minWidth:40,height:35}}/>:<button key={i} disabled={answered} onClick={()=>placeWord(w,i)} style={{padding:"7px 13px",borderRadius:50,background:T.card,border:`2px solid ${T.border}`,fontFamily:"'DM Sans',sans-serif",fontWeight:600,fontSize:14,cursor:"pointer",color:T.text,transition:"all 0.2s"}}>{w}</button>)}
            </div>
          </Card>
        </>}

        {/* WRITE type — AI Writing Checker */}
        {q.type==="write"&&<>
          <Card>
            <div style={{fontSize:18,fontWeight:700,color:T.navy,marginBottom:8,lineHeight:1.5}}>{q.prompt}</div>
            {q.hint&&<div style={{fontSize:13,color:T.textMid,background:T.goldLight,padding:"10px 12px",borderRadius:10,marginBottom:12,border:"1.5px solid #FCD34D"}}>💡 Hint: {q.hint}</div>}
            <div style={{fontSize:12,fontWeight:600,color:T.textSoft,marginBottom:7}}>Write your answer in French — AI will check it: ✍️🤖</div>
            {!answered
              ? <AIWritingChecker
                  prompt={q.prompt}
                  accepted={q.accepted}
                  level={level?.cefrTag||"A1"}
                  onResult={(isCorrect)=>{
                    if(!answered){
                      setAnswered(true);
                      if(isCorrect){setCorrect(x=>x+1);setXp(x=>x+(q.diff||1)*15);}
                      speak(isCorrect?`${c.messages.correct} ${q.explain}`:`${c.messages.wrong} ${q.explain}`);
                    }
                  }}
                />
              : <div style={{padding:12,borderRadius:10,background:isOk?T.mintLight:T.redLight,fontSize:14,color:T.text,fontStyle:"italic"}}>✅ Answer submitted</div>
            }
          </Card>
        </>}

        {/* SPEAK type — AI Speaking Coach */}
        {q.type==="speak"&&<>
          <Card style={{border:`2px solid #F9731620`,background:"linear-gradient(135deg,#FFF7ED,#FEF3C7)"}}>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:18,fontWeight:700,color:T.navy,marginBottom:12}}>{q.prompt}</div>
            <AISpeakingCoach
              prompt={q.prompt}
              sampleAnswer={q.sampleAnswer||q.accepted?.[0]||""}
              onDone={(passed)=>{
                setSpeakDone(true);
                if(!answered){
                  setAnswered(true);
                  if(passed){setCorrect(x=>x+1);setXp(x=>x+(q.diff||1)*15);}
                  speak(passed?`${c.messages.correct} ${q.explain}`:`${c.messages.wrong} ${q.explain}`);
                }
              }}
            />
          </Card>
        </>}

        {/* Feedback */}
        {answered&&<div style={{padding:"16px 18px",borderRadius:16,background:isOk?"linear-gradient(135deg,#D1FAE5,#ECFDF5)":"linear-gradient(135deg,#FEF3C7,#FFFBEB)",border:`2px solid ${isOk?"#6EE7B7":"#FCD34D"}`,display:"flex",alignItems:"flex-start",gap:12,animation:"slideUp 0.3s ease"}}>
          <span style={{fontSize:24,flexShrink:0}}>{isOk?"✅":"💡"}</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:14,color:isOk?"#065F46":"#92400E",marginBottom:5}}>{isOk?"Correct! You're getting it! 🌟":"Good try — here's how it works:"}</div>
            <div style={{fontSize:13,color:isOk?"#065F46":"#78350F",lineHeight:1.65}}>{q.explain}</div>
            {!isOk&&<div style={{marginTop:8,fontSize:12,color:"#92400E",fontWeight:600}}>Don't worry — mistakes are how the brain learns! 🧠</div>}
          </div>
        </div>}

        {/* Action buttons */}
        <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          {!answered
            ?<Btn onClick={checkAnswer} disabled={
                (q.type==="tap"||q.type==="mcq"||q.type==="fill")?selected===null:
                q.type==="order"?orderPlaced.length===0:
                q.type==="write"||q.type==="speak"?false:false
              }>{q.type==="write"||q.type==="speak"?"AI is checking... ✓":"Check Answer ✓"}</Btn>
            :<Btn onClick={nextQ}>{qIdx<total-1?"Next Question →":"See Results →"}</Btn>}
          {!answered&&q.type!=="speak"&&q.type!=="write"&&<Btn variant="ghost" onClick={nextQ}>Skip →</Btn>}
          {!answered&&<AIHintButton question={q} level={level?.cefrTag||"A1"}/>}
        </div>
      </>}

      {/* DONE PHASE — with confetti, streak, XP */}
      {phase==="done"&&<div style={{position:"relative",display:"flex",flexDirection:"column",alignItems:"center",gap:20,textAlign:"center",padding:"32px 16px",overflow:"hidden"}}>

        {/* Confetti burst */}
        {showConfetti&&<div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:9999}}>
          {Array.from({length:60}).map((_,i)=>{
            const colors=[T.mint,T.gold,T.blue,"#F472B6","#A78BFA","#34D399","#FCD34D"];
            const x=Math.random()*100; const delay=Math.random()*1.5; const size=6+Math.random()*8;
            return <div key={i} style={{position:"absolute",left:`${x}%`,top:"-10px",width:size,height:size,borderRadius:Math.random()>0.5?"50%":"2px",background:colors[i%colors.length],animation:`confettiFall ${1.5+Math.random()*2}s ${delay}s ease-in forwards`,transform:`rotate(${Math.random()*360}deg)`}}/>;
          })}
        </div>}

        {/* Trophy emoji */}
        <div style={{fontSize:80,animation:"float 3s ease-in-out infinite",filter:correct>=total*0.8?"drop-shadow(0 0 20px gold)":"none"}}>
          {correct>=total*0.8?"🏆":correct>=total*0.6?"🎉":correct>=total*0.4?"💪":"📚"}
        </div>

        <div style={{fontFamily:"'Playfair Display',serif",fontSize:30,fontWeight:900,color:T.navy}}>
          {correct>=total*0.8?"Outstanding! 🌟":correct>=total*0.6?"Great Work!":correct>=total*0.4?"Good Effort!":"Keep Going!"}</div>

        <div style={{fontSize:15,color:T.textMid,maxWidth:420,lineHeight:1.7}}>
          {correct>=total*0.8?"You're thinking in French — that's the real milestone. CLB-level thinking! 🍁":
           correct>=total*0.6?"Solid! Review the explanations for what you missed — they'll stick better next time.":
           correct>=total*0.4?"Every attempt literally rewires your brain for French. Keep going!":
           "Struggling = learning. The brain only grows when it's challenged. Try again — you WILL improve!"}
        </div>

        {/* Stats row */}
        <div style={{display:"flex",gap:12,flexWrap:"wrap",justifyContent:"center"}}>
          {[
            {val:`${correct}/${total}`,lbl:"Correct",icon:"✅",bg:T.mintLight,col:"#065F46"},
            {val:`${Math.round((correct/total)*100)}%`,lbl:"Accuracy",icon:"🎯",bg:T.blueLight,col:T.navy},
            {val:`+${xp}`,lbl:"XP Earned",icon:"⭐",bg:T.goldLight,col:"#92400E"},
            {val:`${streak}🔥`,lbl:"Day Streak",icon:"🔥",bg:"#FFF7ED",col:"#C2410C"},
          ].map(s=><div key={s.lbl} style={{minWidth:90,textAlign:"center",padding:"16px 18px",borderRadius:16,background:s.bg,border:`1.5px solid ${s.col}20`}}>
            <div style={{fontSize:10,marginBottom:4}}>{s.icon}</div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:24,fontWeight:700,color:s.col}}>{s.val}</div>
            <div style={{fontSize:10,color:T.textSoft,textTransform:"uppercase",letterSpacing:.8,marginTop:3}}>{s.lbl}</div>
          </div>)}
        </div>

        {/* Motivational bar */}
        {correct>=total*0.7&&<div style={{padding:"14px 24px",borderRadius:50,background:"linear-gradient(135deg,#FEF3C7,#FDE68A)",border:"1.5px solid #FCD34D",fontSize:15,fontWeight:700,color:"#92400E"}}>
          ⭐ +{xp} XP — fantastic lesson! You&apos;re building real French skills.
        </div>}

        {/* What you learned recap */}
        <div style={{width:"100%",maxWidth:480,background:T.surface,borderRadius:16,padding:"16px 20px",border:`1.5px solid ${T.border}`,textAlign:"left"}}>
          <div style={{fontSize:12,fontWeight:700,color:T.textSoft,textTransform:"uppercase",letterSpacing:.8,marginBottom:10}}>📝 Key phrases from this lesson — click 🔈 to hear them:</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {lesson.vocab.slice(0,6).map(v=><span key={v} style={{fontSize:12,padding:"5px 11px",borderRadius:50,background:T.blueLight,color:T.navy,fontWeight:600,fontStyle:"italic"}}>{v}</span>)}
          </div>
        </div>

        {/* Actions */}
        <div style={{display:"flex",gap:10,flexWrap:"wrap",justifyContent:"center"}}>
          <Btn onClick={()=>onComplete(lesson.id)} style={{padding:"15px 32px",fontSize:15}}>✓ Complete &amp; Continue</Btn>
          <Btn variant="secondary" onClick={()=>{setPhase("questions");setQIdx(0);setSelected(null);setWriteVal("");setAnswered(false);setCorrect(0);setXp(0);setSpeakDone(false);setShowConfetti(false);}}>↺ Try Again</Btn>
        </div>
      </div>}
    </div>
  </div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRACTICE SCREEN — 6 games
// ─────────────────────────────────────────────────────────────────────────────
// ─── AI UTILITIES ─────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = (import.meta.env.VITE_ANTHROPIC_API_KEY || "").trim();

async function callClaude(systemPrompt, userMessage, maxTokens=600){
  try{
    const res = await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version":"2023-06-01",
        "anthropic-dangerous-direct-browser-access":"true"
      },
      body:JSON.stringify({
        model:"claude-sonnet-4-20250514",
        max_tokens:maxTokens,
        system:systemPrompt,
        messages:[{role:"user",content:userMessage}]
      })
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text || "Je suis désolé, une erreur s'est produite.";
  }catch(e){
    console.warn("Claude API error:",e);
    return "Je suis désolé — l'IA n'est pas disponible pour le moment. Essayez de rafraîchir la page! 🔄";
  }
}

// ─── AI SPEAKING COACH ────────────────────────────────────────────────────────
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
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:17,fontWeight:700,color:T.navy}}>AI Speaking Coach</div>
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
      <button onClick={startRecording} style={{background:"#F97316",color:"#fff",border:"none",padding:"14px 28px",borderRadius:14,fontWeight:700,fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",gap:8,fontFamily:"'DM Sans',sans-serif"}}>
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
      <button onClick={stopRecording} style={{background:T.navy,color:"#fff",border:"none",padding:"12px 24px",borderRadius:12,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
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
        <button onClick={()=>{setStage("ready");setFeedback(null);}} style={{background:"rgba(255,255,255,0.8)",border:`1.5px solid ${T.border}`,padding:"10px 18px",borderRadius:10,fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",color:T.navy}}>Try Again 🔄</button>
        <button onClick={()=>onDone(feedback.score>=60)} style={{background:T.mint,color:"#fff",border:"none",padding:"10px 20px",borderRadius:10,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Continue →</button>
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
        style={{width:"100%",padding:14,borderRadius:12,border:`2px solid ${result?(result.correct?T.mint:T.red):T.border}`,fontFamily:"'DM Sans',sans-serif",fontSize:15,color:T.text,background:T.card,resize:"none",minHeight:80,outline:"none",transition:"border-color 0.2s",boxSizing:"border-box"}}/>
      <div style={{position:"absolute",bottom:10,right:12,fontSize:11,color:T.textSoft}}>{val.length} chars · AI-checked 🤖</div>
    </div>

    {!result&&<button onClick={checkWithAI} disabled={!val.trim()||checking}
      style={{background:val.trim()&&!checking?T.blue:"#cbd5e1",color:"#fff",border:"none",padding:"11px 22px",borderRadius:10,fontWeight:700,fontSize:14,cursor:val.trim()&&!checking?"pointer":"not-allowed",fontFamily:"'DM Sans',sans-serif",display:"flex",alignItems:"center",gap:8}}>
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
  const[open,setOpen]=useState(false);
  const[hint,setHint]=useState("");
  const[loading,setLoading]=useState(false);

  const getHint=async()=>{
    if(hint){setOpen(true);return;}
    setOpen(true);setLoading(true);
    const sys=`You are a friendly French tutor. Give a SHORT, helpful hint for a ${level} level Canadian French learner. 
Don't give away the answer — guide them to it. 2-3 sentences max. Use one encouraging emoji.`;
    const msg=`Question: "${question.prompt}"
Type: ${question.type}
${question.type==="write"?"Accepted answers (don't reveal directly): "+question.accepted?.join(", "):"Options: "+question.options?.join(", ")}
Give a gentle hint that helps without spoiling the answer.`;
    const h=await callClaude(sys,msg,150);
    setHint(h);setLoading(false);
  };

  return <div style={{position:"relative"}}>
    <button onClick={getHint} style={{background:"linear-gradient(135deg,#8B5CF6,#6D28D9)",color:"#fff",border:"none",padding:"8px 16px",borderRadius:10,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",display:"flex",alignItems:"center",gap:6}}>
      🧠 AI Hint
    </button>
    {open&&<div style={{position:"absolute",bottom:"calc(100% + 8px)",left:0,background:"#fff",borderRadius:14,padding:16,boxShadow:"0 8px 40px rgba(0,0,0,0.15)",border:`2px solid #8B5CF6`,width:280,zIndex:50,animation:"popIn 0.2s ease"}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
        <div style={{fontSize:12,fontWeight:700,color:"#6D28D9",textTransform:"uppercase",letterSpacing:.8}}>🧠 AI Hint</div>
        <button onClick={()=>setOpen(false)} style={{background:"none",border:"none",cursor:"pointer",fontSize:14,color:T.textSoft}}>✕</button>
      </div>
      {loading?<div style={{textAlign:"center",padding:"10px 0"}}><span style={{animation:"float 0.8s infinite",fontSize:20}}>🧠</span><div style={{fontSize:12,color:T.textSoft,marginTop:6}}>Thinking...</div></div>
      :<div style={{fontSize:14,color:T.text,lineHeight:1.65}}>{hint}</div>}
    </div>}
  </div>;
}

// ─── AI CONVERSATION PARTNER ──────────────────────────────────────────────────
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
    setMatchSel(null);setMatchDone([]);setFillSel(null);
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
      <div style={{fontFamily:"'Playfair Display',serif",fontSize:26,fontWeight:900,color:T.navy,marginBottom:6}}>💬 AI Conversation Partner</div>
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
      <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:700,color:T.navy,marginBottom:14}}>🎮 Practice Games</div>
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
        <button onClick={()=>{setTopic(null);setMsgs([]);}} style={{background:"none",border:`1.5px solid ${T.border}`,padding:"6px 12px",borderRadius:8,cursor:"pointer",fontSize:13,color:T.textMid,fontFamily:"'DM Sans',sans-serif"}}>← Back</button>
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
          style={{flex:1,padding:"12px 14px",borderRadius:12,border:`1.5px solid ${T.border}`,fontFamily:"'DM Sans',sans-serif",fontSize:14,resize:"none",minHeight:44,maxHeight:120,outline:"none",color:T.text,lineHeight:1.5}}
          rows={1}/>
        <button onClick={sendMessage} disabled={!input.trim()||loading}
          style={{background:input.trim()&&!loading?T.blue:"#cbd5e1",color:"#fff",border:"none",padding:"12px 18px",borderRadius:12,fontWeight:700,fontSize:14,cursor:input.trim()&&!loading?"pointer":"not-allowed",fontFamily:"'DM Sans',sans-serif",flexShrink:0,transition:"all 0.2s"}}>
          {loading?"...":"Send →"}
        </button>
      </div>
    </div>;
  }

  return null;
}

function ProfileScreen({companion,progress,startLevel,onReset,user,guestMode,onAuthNav}){
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
        <span style={{fontFamily:"'Playfair Display',serif",fontSize:16,fontWeight:700,color:T.navy,letterSpacing:1}}>FRANCO</span>
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
      <Row emoji="📈" label="Subscription" onClick={()=>window.open("https://buy.stripe.com/7sY6oIaaYfe6c0K6Di2go00","_blank")}/>
      <Row emoji="🍁" label="Immigration Services" onClick={()=>window.open("mailto:admin@junglelabsworld.com?subject=Immigration Services","_blank")}/>
      <Row emoji="📞" label="Contact Us" onClick={()=>window.open("mailto:support@clbfrenchtrainer.app","_blank")}/>
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
      ? <button onClick={()=>onAuthNav("landing")} style={{width:"100%",padding:"15px",background:T.navy,color:"#fff",border:"none",borderRadius:14,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:15,cursor:"pointer",marginBottom:12}}>
          Create Account / Login
        </button>
      : <button onClick={handleLogout} style={{width:"100%",padding:"15px",background:T.surface,color:T.textMid,border:`1px solid ${T.border}`,borderRadius:14,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:15,cursor:"pointer",marginBottom:12}}>
          Sign Out
        </button>
    }

    <div style={{textAlign:"center",fontSize:12,color:T.textSoft}}>Powered by Jungle Labs</div>
  </div>;
}


function TopBar({screen,onNavigate,companion,progress,user,guestMode,onAuthNav}){
  const{logout}=useAuth();
  const xp=Object.keys(progress).length*25;
  const nav=[{id:"dashboard",label:"Home",emoji:"🏠"},{id:"hub",label:"Learn",emoji:"📚"},{id:"practice",label:"Practice",emoji:"⚡"},{id:"profile",label:"Profile",emoji:"👤"}];
  const handleLogout=async()=>{ await logout(); window.location.reload(); };
  const displayName=user?.displayName||user?.email?.split("@")[0]||null;
  return <div style={{background:T.card,borderBottom:`1px solid ${T.border}`,padding:"0 20px",display:"flex",alignItems:"center",height:64,gap:8,position:"sticky",top:0,zIndex:100,boxShadow:"0 1px 8px rgba(0,0,0,0.06)"}}>
    <div style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:900,color:T.navy,marginRight:4}}>Franco</div>
    <div style={{fontSize:16,marginRight:8}}>🍁</div>
    {guestMode&&<span style={{fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:50,background:"#FEF3C7",color:"#92400E",border:"1px solid #FCD34D"}}>Guest</span>}
    <div style={{flex:1}}/>
    <div style={{display:"flex",gap:4}}>
      {nav.map(n=><button key={n.id} onClick={()=>onNavigate(n.id)} style={{padding:"8px 14px",borderRadius:10,border:"none",background:screen===n.id?T.blueLight:"transparent",color:screen===n.id?T.blue:T.textMid,fontFamily:"'DM Sans',sans-serif",fontWeight:screen===n.id?700:500,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",gap:6,transition:"all 0.2s"}}>{n.emoji} {n.label}</button>)}
    </div>
    <div style={{flex:1}}/>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <Pill variant="gold">⭐ {xp} XP</Pill>
      {displayName&&<span style={{fontSize:13,fontWeight:600,color:T.textMid,maxWidth:100,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>👋 {displayName}</span>}
      {user
        ? <button onClick={handleLogout} style={{fontSize:12,fontWeight:700,padding:"6px 12px",borderRadius:8,border:`1px solid ${T.border}`,background:"transparent",color:T.textMid,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Sign out</button>
        : guestMode&&<button onClick={()=>onAuthNav("landing")} style={{fontSize:12,fontWeight:700,padding:"6px 12px",borderRadius:8,border:`1px solid ${T.blue}`,background:T.blueLight,color:T.blue,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>Sign in</button>
      }
      <div style={{width:36,height:36,borderRadius:"50%",background:T.navy,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>{companion?.emoji||"👤"}</div>
    </div>
  </div>;
}

export default function App(){
  return <AuthProvider><AppInner/></AuthProvider>;
}

function AppInner(){
  const{user,initializing}=useAuth();
  const[authScreen,setAuthScreen]=useLocalState("franco_auth_screen","landing");
  const[authParams,setAuthParams]=useState({});
  const[screen,setScreen]=useLocalState("franco_screen","welcome");
  const[companion,setCompanion]=useLocalState("franco_companion",null);
  const[startLevel,setStartLevel]=useLocalState("franco_level","foundation");
  const[progress,setProgress]=useLocalState("franco_progress",{});
  const[activeLesson,setActiveLesson]=useState(null);
  const[paywallLesson,setPaywallLesson]=useState(null);
  const[guestMode,setGuestMode]=useLocalState("franco_guest",false);

  // Check if returning from Stripe payment
  useEffect(()=>{checkStripeSuccess();},[]);

  useEffect(()=>{
    const s=document.createElement("style");
    s.textContent=`
      @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');
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
  const handleLessonComplete=(lessonId)=>{setProgress(p=>({...p,[lessonId]:true}));setScreen("hub");setActiveLesson(null);};

  // Loading spinner while Firebase initializes
  if(initializing) return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F7FAFF",flexDirection:"column",gap:16}}>
      <div style={{fontSize:48,animation:"float 1.5s ease-in-out infinite"}}>🍁</div>
      <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:14,color:"#475569"}}>Loading Franco...</div>
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
  return <div style={{fontFamily:"'DM Sans',sans-serif",background:T.surface,minHeight:"100vh",color:T.text}}>
    {showNav&&<TopBar screen={screen} onNavigate={setScreen} companion={companion} progress={progress} user={user} guestMode={guestMode} onAuthNav={goAuth}/>}
    {screen==="welcome"&&<WelcomeScreen onNext={()=>setScreen(companion?"dashboard":"onboarding")}/>}
    {screen==="onboarding"&&<OnboardingScreen onComplete={handleOnboard}/>}
    {screen==="dashboard"&&<DashboardScreen companion={companion} startLevel={startLevel} progress={progress} onNavigate={setScreen} user={user} guestMode={guestMode}/>}
    {screen==="hub"&&<HubScreen progress={progress} onStartLesson={handleStartLesson}/>}
    {screen==="lesson"&&activeLesson&&<LessonScreen lesson={activeLesson.lesson} level={activeLesson.level} companion={companion} onComplete={handleLessonComplete} onBack={()=>setScreen("hub")}/>}
    {screen==="practice"&&<PracticeScreen companion={companion}/>}
    {screen==="profile"&&<ProfileScreen companion={companion} progress={progress} startLevel={startLevel} onReset={()=>{setProgress({});setScreen("dashboard");}} user={user} guestMode={guestMode} onAuthNav={goAuth}/>}
    {paywallLesson&&<PaywallModal lessonTitle={paywallLesson.title} onClose={()=>setPaywallLesson(null)}/>}
  </div>;
}
