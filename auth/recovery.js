const crypto=require('node:crypto');
const {email,passwordValid,hashPassword,hashToken}=require('./customers');
const TTL=600000;
const MESSAGE='If an account matches that email address, a password reset link will be sent.';
function installPasswordRecovery(app,{store,emailProvider,route,rateLimit,validOrigin,clientKey,secure,now=Date.now,reportFailure=()=>{}}) {
 const cookieOptions={httpOnly:true,secure,sameSite:'strict',path:'/api/customer/recovery'};
 const legacyName=(secure?'__Secure-':'')+'er_customer_recovery';
 const resetName=(secure?'__Secure-':'')+'er_customer_reset';
 const cookieToken=(req,name)=>{
  const values=String(req.headers.cookie || '').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
  if(values.length!==1)return null;const raw=values[0].slice(name.length+1);return /^[A-Za-z0-9_-]{43}$/.test(raw)?raw:null;
 };
 const clear=res=>{res.clearCookie(legacyName,cookieOptions);res.clearCookie(resetName,cookieOptions);};
 const reject=res=>res.status(400).json({error:'This reset link is invalid, expired, or has already been used. Please request a new link.'});
 app.use('/api/customer/recovery',(req,res,next)=>{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  if(!emailProvider?.enabled)return res.status(503).json({error:'Password recovery is temporarily unavailable. Please try again.'});
  if(!validOrigin(req) || !req.is('application/json'))return res.status(403).json({error:'Invalid request.'});
  if(!req.body || typeof req.body!=='object' || Array.isArray(req.body))return res.status(400).json({error:'Invalid request.'});next();
 });
 app.post('/api/customer/recovery/request',rateLimit('recovery-send',5,60000),route(async(req,res)=>{
  const normalized=email(req.body.email);
  if(!normalized)return res.status(400).json({error:'Enter a valid email address.'});
  const raw=crypto.randomBytes(32).toString('base64url'),at=now();
  const record={challenge_hash:hashToken(crypto.randomBytes(32)),identity_hash:hashToken(normalized.normalized),email_token_hash:hashToken(raw)};
  const result=await store.prepareRecovery(record,normalized.normalized,hashToken(clientKey(req)),at);
  res.json({message:MESSAGE});
  // Persist first, respond uniformly, then send outside the transaction. Never persist the link.
  if(result.prepared && result.email) {
   const delivery=async()=>{
    let sent=false;
    try{await emailProvider.sendResetLink({email:result.email,token:raw,attemptId:record.challenge_hash});sent=true;}catch(_){reportFailure(req);}
    try{await store.finishRecoveryDelivery(record.challenge_hash,sent);}catch(_){reportFailure(req);}
   };
   void delivery();
  }
 }));
 app.post('/api/customer/recovery/exchange',rateLimit('recovery-exchange',30,60000),route(async(req,res)=>{
  const raw=req.body.token;
  if(typeof raw!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(raw))return reject(res);
  const grant=crypto.randomBytes(32).toString('base64url');
  const outcome=await store.exchangeRecovery(hashToken(raw),hashToken(grant),now());
  if(!outcome)return reject(res);
  res.cookie(resetName,grant,{...cookieOptions,maxAge:Math.max(0,new Date(outcome.expiresAt).getTime()-now())});
  res.json({ok:true});
 }));
 app.post('/api/customer/recovery/reset',rateLimit('recovery-reset',10,60000),route(async(req,res)=>{
  const raw=cookieToken(req,resetName),p=req.body.password;
  if(!raw || !await store.recoveryGrant(hashToken(raw),now()))return reject(res);
  if(!passwordValid(p))return res.status(400).json({error:'Use a password between 10 and 128 characters.'});
  if(typeof req.body.confirmPassword!=='string' || req.body.confirmPassword!==p)return res.status(400).json({error:'Passwords must match.'});
  const encoded=await hashPassword(p);
  if(!await store.resetCustomerPassword(hashToken(raw),encoded,now()))return reject(res);
  clear(res);
  const sessionOptions={httpOnly:true,secure,sameSite:'strict',path:'/'};
  res.clearCookie(secure?'__Host-er_customer_session':'er_customer_session',sessionOptions);
  res.json({message:'Password updated. Please sign in with your new password.'});
 }));
}
module.exports={installPasswordRecovery,TTL,MESSAGE};
