const crypto=require('node:crypto');
const {phone,passwordValid,hashPassword,hashToken}=require('./customers');
const TTL=600000;
const MESSAGE='If an account matches that phone number, a verification code will be sent.';
const randomCode=()=>String(crypto.randomInt(0,1000000)).padStart(6,'0');
const verifier=(token,code)=>crypto.createHmac('sha256',token).update('customer-recovery-v1:'+code).digest('hex');
function installPasswordRecovery(app,{store,smsProvider,route,rateLimit,validOrigin,clientKey,secure,now=Date.now,codeFactory=randomCode,reportFailure=()=>{}}) {
 const cookieOptions={httpOnly:true,secure,sameSite:'strict',path:'/api/customer/recovery'};
 const challengeName=(secure?'__Secure-':'')+'er_customer_recovery';
 const resetName=(secure?'__Secure-':'')+'er_customer_reset';
 const cookieToken=(req,name)=>{
  const values=String(req.headers.cookie || '').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
  if(values.length!==1)return null;const raw=values[0].slice(name.length+1);return /^[A-Za-z0-9_-]{43}$/.test(raw)?raw:null;
 };
 const clear=res=>{res.clearCookie(challengeName,cookieOptions);res.clearCookie(resetName,cookieOptions);};
 const reject=res=>res.status(400).json({error:'Unable to verify recovery. Please request a new code or try again.'});
 app.use('/api/customer/recovery',(req,res,next)=>{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  if(!smsProvider?.enabled)return res.status(503).json({error:'Password recovery is temporarily unavailable. Please try again.'});
  if(!validOrigin(req) || !req.is('application/json'))return res.status(403).json({error:'Invalid request.'});
  if(!req.body || typeof req.body!=='object' || Array.isArray(req.body))return res.status(400).json({error:'Invalid request.'});next();
 });
 app.post('/api/customer/recovery/request',rateLimit('recovery-send',5,60000),route(async(req,res)=>{
  const normalized=phone(req.body.phone);
  if(!normalized)return res.status(400).json({error:'Enter a valid U.S. phone number.'});
  const raw=crypto.randomBytes(32).toString('base64url'),code=codeFactory();
  if(!/^\d{6}$/.test(code))throw new Error('Recovery invariant');
  const record={challenge_hash:hashToken(raw),identity_hash:hashToken(normalized.normalized),code_verifier:verifier(raw,code)};
  const old=cookieToken(req,challengeName),at=now();
  const result=await store.prepareRecovery(record,normalized.normalized,hashToken(clientKey(req)),old?hashToken(old):null,at);
  const selected=result.retained?old:raw;
  const maxAge=result.retained?Math.max(0,new Date(result.retained.expires_at).getTime()-at):TTL;
  res.clearCookie(resetName,cookieOptions);
  res.cookie(challengeName,selected,{...cookieOptions,maxAge});
  res.json({message:MESSAGE});
  // Provider work is outside the transaction and response, avoiding provider-timing enumeration.
  // A crash before delivery never grants recovery authority; expiry/resend permits a safe retry.
  if(result.prepared && result.phone) {
   const delivery=async()=>{
    let sent=false;
    try{await smsProvider.sendCode({phone:result.phone,code,signal:AbortSignal.timeout(8000)});sent=true;}catch(_){reportFailure(req);}
    try{await store.finishRecoveryDelivery(record.challenge_hash,sent);}catch(_){reportFailure(req);}
   };
   void delivery();
  }
 }));
 app.post('/api/customer/recovery/verify',rateLimit('recovery-verify',30,60000),route(async(req,res)=>{
  const raw=cookieToken(req,challengeName),code=req.body.code;
  if(!raw)return reject(res);
  const validCode=typeof code==='string' && /^\d{6}$/.test(code);
  const grant=crypto.randomBytes(32).toString('base64url');
  const outcome=await store.verifyRecovery(hashToken(raw),verifier(raw,validCode?code:'invalid-code'),hashToken(grant),now());
  if(!outcome)return reject(res);
  // Grant lifetime is bounded by the original challenge, never extended by verification.
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
module.exports={installPasswordRecovery,randomCode,verifier,TTL,MESSAGE};
