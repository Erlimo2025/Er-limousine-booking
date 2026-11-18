'use strict';

const crypto = require('node:crypto');
const {hashPassword,verifyPassword,passwordValid,email,hashToken} = require('./customers');
const SESSION_MS=8*60*60_000,IDLE_MS=30*60_000,CHALLENGE_MS=5*60_000;
const LIMITS=Object.freeze({login:{identity:20,source:30,window:15*60_000},mfa:{identity:8,source:30,window:5*60_000},recovery:{identity:8,source:20,window:15*60_000}});
const unavailable=()=>Object.assign(new Error('Dispatch authentication unavailable.'),{status:503});
function encryptionKey(value) {
  if(typeof value!=='string'||value.length!==44||!/^[A-Za-z0-9+/]{43}=$/.test(value))throw unavailable();
  const key=Buffer.from(value,'base64');if(key.length!==32||key.toString('base64')!==value)throw unavailable();return key;
}
function encryptSeed(seed,key,ownerId='') {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(ownerId));const encrypted=Buffer.concat([cipher.update(seed,'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
}
function decryptSeed(encoded,key,ownerId='') {
  try {
    if(typeof encoded!=='string'||encoded.length>250)throw Error();
    const [version,iv,tag,data,...extra]=encoded.split('.');if(version!=='v1'||extra.length||!iv||!tag||!data||Buffer.from(iv,'base64url').length!==12||Buffer.from(tag,'base64url').length!==16)throw Error();
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));
    decipher.setAAD(Buffer.from(ownerId));decipher.setAuthTag(Buffer.from(tag,'base64url'));
    const seed=Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8');
    if(!/^[A-Z2-7]{32,64}$/.test(seed))throw Error();return seed;
  }catch(_){throw unavailable();}
}
function totpStep(seed,code,now,lastStep=null) {
  if(typeof code!=='string'||code.length!==6||!/^\d{6}$/.test(code))return null;
  const OTPAuth=require('otpauth');
  const totp=new OTPAuth.TOTP({issuer:'ER Limousine Dispatch',label:'Owner',algorithm:'SHA1',digits:6,period:30,secret:seed});
  const delta=totp.validate({token:code,timestamp:now,window:1});
  if(delta===null||delta>0)return null;
  const step=Math.floor(now/30_000)+delta;
  return lastStep!==null&&step<=Number(lastStep)?null:step;
}
function generateEnrollment(label) {
  const OTPAuth=require('otpauth');
  const secret=new OTPAuth.Secret({size:20});
  return {secret:secret.base32,uri:new OTPAuth.TOTP({issuer:'ER Limousine Dispatch',label,algorithm:'SHA1',digits:6,period:30,secret}).toString()};
}
const recoveryCodes=()=>Array.from({length:8},()=>crypto.randomBytes(12).toString('hex').match(/.{4}/g).join('-'));
const recoveryHash=value=>typeof value==='string'&&value.length===29&&/^(?:[a-f0-9]{4}-){5}[a-f0-9]{4}$/i.test(value)?hashToken(value.toLowerCase()):null;
function installDispatchOwner(app,{store,route,validOrigin,secure,clientKey,now=Date.now,emit=()=>{},env=process.env}) {
  const enabled=env.DISPATCH_OWNER_ENABLED==='true';
  if(!enabled)return {enabled:false,resolve:async()=>null,current:()=>null,recheck:async()=>false,requireOwner:(req,res)=>res.status(401).json({error:'Unauthorized'}),logout:async()=>false};
  const key=encryptionKey(env.DISPATCH_MFA_KEY);
  const sessionName=secure?'__Host-er_dispatch_owner_session':'er_dispatch_owner_session';
  const challengeName=secure?'__Host-er_dispatch_challenge':'er_dispatch_challenge';
  const cookieOptions={httpOnly:true,secure,sameSite:'strict',path:'/'};
  const prefix='/api/admin/owner';
  const rawCookie=(req,name)=> {
    const matches=String(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));
    if(matches.length!==1)return null;const token=matches[0].slice(name.length+1);return token.length===43&&/^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
  };
  const sessionHash=req=>{const raw=rawCookie(req,sessionName);return raw?hashToken(raw):null;};
  const challengeHash=req=>{const raw=rawCookie(req,challengeName);return raw?hashToken(raw):null;};
  const clearChallenge=res=>res.clearCookie(challengeName,cookieOptions);
  const clearSession=res=>res.clearCookie(sessionName,cookieOptions);
  const freshChallenge=()=>{const raw=crypto.randomBytes(32).toString('base64url');return {raw,hash:hashToken(raw)};};
  const issueChallenge=(res,c)=>res.cookie(challengeName,c.raw,{...cookieOptions,maxAge:CHALLENGE_MS});
  const publicOwner=row=>({id:row.id,name:row.name??row.display_name,email:row.email??row.normalized_email,mfaEnabled:true});
  const mutationAction=req=>{
    if(req.method!=='POST')return null;
    const path=req.path.startsWith(prefix)?req.path.slice(prefix.length):req.path;
    const actions={'/login':'dispatch_sign_in','/verify':'dispatch_sign_in','/logout':'dispatch_logout',
      '/enrollment/start':'owner_mfa_enrollment','/enrollment/confirm':'owner_mfa_enrollment',
      '/recover':'owner_recovery','/sessions/revoke-others':'owner_sessions_revoked',
      '/recovery-codes':'owner_recovery_codes'};
    return Object.hasOwn(actions,path)?actions[path]:null;
  };
  function audit(req,action,outcome='succeeded') {return {timestamp:new Date(now()).toISOString(),referenceId:req.referenceId,action,outcome};}
  function report(req,action,outcome,options={}) {try{const result=emit(req,action,outcome,options);if(result?.catch)result.catch(()=>{});}catch(_) {}}
  const deny=(req,res,action,status=401)=>{report(req,action,status===403||status===401||status===429?'denied':'failed');return res.status(status).json({error:status===429?'Too many attempts. Please try again later.':'Unable to authenticate. Please try again.'});};
  const mutation=(req,res,next)=>{
    if(!validOrigin(req)||!req.is('application/json')){
      const action=mutationAction(req);if(action)report(req,action,'denied');
      return res.status(403).json({error:'Unauthorized'});
    }
    if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))return res.status(400).json({error:'Invalid request.'});next();
  };
  const only=(req,keys)=>Object.keys(req.body).every(k=>keys.includes(k));
  async function limit(req,kind,identity) {
    const policy=LIMITS[kind],at=now();
    if(!await store.dispatchAuthLimit(kind+'_source',hashToken(String(clientKey(req))),at,policy.source,policy.window))return false;
    return store.dispatchAuthLimit(kind+'_identity',hashToken(String(identity)),at,policy.identity,policy.window);
  }
  async function resolve(req,{touch=true}={}) {
    const hash=sessionHash(req);req.dispatchOwner=null;
    if(!hash)return null;
    const row=await store.dispatchResolveSession(hash,now(),touch);if(!row)return null;
    const owner={id:row.id,name:row.display_name,email:row.normalized_email,mfaEnabled:true,actorId:row.actor_id,sessionHash:hash,expiresAt:Math.min(new Date(row.expires_at).getTime(),(touch?now():new Date(row.last_seen_at).getTime())+IDLE_MS)};
    req.dispatchOwner=owner;
    req.adminArchiveAuthority={staffId:owner.id,actorId:owner.actorId,authorized:()=>recheck(req)};
    return owner;
  }
  async function recheck(req) {
    if(!req.dispatchOwner)return false;
    const row=await store.dispatchResolveSession(req.dispatchOwner.sessionHash,now(),false);
    return !!row&&row.id===req.dispatchOwner.id&&row.actor_id===req.dispatchOwner.actorId;
  }
  const current=req=>req.dispatchOwner||null;
  async function requireOwner(req,res,next) {
    if(!validOrigin(req))return res.status(403).json({error:'Unauthorized'});
    if(!await resolve(req)){clearSession(res);return res.status(401).json({error:'Unauthorized'});}return next();
  }
  async function logout(req,res) {
    const hash=sessionHash(req),challenge=challengeHash(req);let removed=null;
    if(hash||challenge)removed=await store.dispatchRevokeSession(hash,audit(req,'dispatch_logout'),challenge);
    report(req,'dispatch_logout',removed?'succeeded':'unchanged',{staffId:removed?.owner_id,actorId:removed?.actor_id});
    clearSession(res);clearChallenge(res);req.dispatchOwner=null;return true;
  }
  app.use(prefix,(req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
    if(!validOrigin(req)){
      const action=mutationAction(req);if(action)report(req,action,'denied');
      return res.status(403).json({error:'Unauthorized'});
    }
    next();
  });
  app.post(prefix+'/login',mutation,route(async(req,res)=>{
    if(!only(req,['email','password']))return deny(req,res,'dispatch_sign_in',400);
    const e=email(req.body.email),password=req.body.password;
    if(!await limit(req,'login',e?.normalized||'invalid'))return deny(req,res,'dispatch_sign_in',429);
    const row=e?await store.dispatchOwnerByEmail(e.normalized):null;
    const valid=passwordValid(password);
    const matched=await verifyPassword(valid?password:'invalid-owner-password',row?.password_hash);
    if(!valid||!matched||row?.account_status!=='active')return deny(req,res,'dispatch_sign_in');
    const challenge=freshChallenge(),purpose=await store.dispatchCreateChallenge(row.id,row.password_hash,challenge,now());
    if(!purpose)return deny(req,res,'dispatch_sign_in');
    issueChallenge(res,challenge);res.json({step:purpose});
  }));
  app.post(prefix+'/enrollment/start',mutation,route(async(req,res)=>{
    if(!only(req,[]))return deny(req,res,'owner_mfa_enrollment',400);
    const hash=challengeHash(req),c=hash?await store.dispatchChallenge(hash,now()):null;
    if(!c||c.purpose!=='enroll')return deny(req,res,'owner_mfa_enrollment');
    if(!await limit(req,'mfa',c.owner_id))return deny(req,res,'owner_mfa_enrollment',429);
    const enrollment=generateEnrollment(c.normalized_email);
    const cipher=await store.dispatchEnrollmentSeed(hash,now(),encryptSeed(enrollment.secret,key,c.owner_id));
    if(!cipher)return deny(req,res,'owner_mfa_enrollment');
    const secret=decryptSeed(cipher,key,c.owner_id);
    const OTPAuth=require('otpauth');
    res.json({secret,uri:new OTPAuth.TOTP({issuer:'ER Limousine Dispatch',label:c.normalized_email,secret,algorithm:'SHA1',digits:6,period:30}).toString()});
  }));
  const complete=expected=>async(req,res)=>{
    const action=expected==='enroll'?'owner_mfa_enrollment':'dispatch_sign_in';
    if(!only(req,['code']))return deny(req,res,action,400);
    const hash=challengeHash(req),c=hash?await store.dispatchChallenge(hash,now()):null;
    if(!c||c.purpose!==expected)return deny(req,res,action);
    if(!await limit(req,'mfa',c.owner_id))return deny(req,res,action,429);
    const at=now(),raw=crypto.randomBytes(32).toString('base64url'),session={hash:hashToken(raw),actorId:crypto.randomUUID(),expires:at+SESSION_MS};
    const codes=recoveryCodes();
    const verified=await store.dispatchCompleteChallenge(hash,at,(cipher,last)=>totpStep(decryptSeed(cipher,key,c.owner_id),req.body.code,at,last),session,codes.map(hashToken),audit(req,action));
    if(!verified)return deny(req,res,action);
    clearChallenge(res);
    const old=sessionHash(req);if(old)await store.dispatchRevokeSession(old);
    res.cookie(sessionName,raw,{...cookieOptions,maxAge:SESSION_MS});
    report(req,action,'succeeded',{staffId:verified.id,actorId:verified.actorId});
    if(expected==='enroll')report(req,'dispatch_sign_in','succeeded',{staffId:verified.id,actorId:verified.actorId});
    res.json({owner:publicOwner(verified),...(expected==='enroll'?{recoveryCodes:codes}:{})});
  };
  app.post(prefix+'/enrollment/confirm',mutation,route(complete('enroll')));
  app.post(prefix+'/verify',mutation,route(complete('mfa')));
  app.post(prefix+'/recover',mutation,route(async(req,res)=>{
    if(!only(req,['email','password','recoveryCode']))return deny(req,res,'owner_recovery',400);
    const e=email(req.body.email),password=req.body.password;
    if(!await limit(req,'recovery',e?.normalized||'invalid'))return deny(req,res,'owner_recovery',429);
    const row=e?await store.dispatchOwnerByEmail(e.normalized):null;
    const matched=await verifyPassword(passwordValid(password)?password:'invalid-owner-password',row?.password_hash);
    const hash=recoveryHash(req.body.recoveryCode),challenge=freshChallenge();
    if(!passwordValid(password)||!matched||!row||!hash||!await store.dispatchRecover(row.id,row.password_hash,hash,challenge,now(),audit(req,'owner_recovery')))return deny(req,res,'owner_recovery');
    clearSession(res);issueChallenge(res,challenge);report(req,'owner_recovery','succeeded',{staffId:row.id});res.json({step:'enroll'});
  }));
  app.get(prefix+'/session',route(requireOwner),route(async(req,res)=>res.json({owner:publicOwner(req.dispatchOwner),expiresAt:req.dispatchOwner.expiresAt})));
  app.get(prefix+'/sessions',route(requireOwner),route(async(req,res)=>{
    const rows=await store.dispatchListSessions(req.dispatchOwner.id,now());
    if(!await recheck(req))return res.status(401).json({error:'Unauthorized'});
    res.json({sessions:rows.map(r=>({id:r.id,current:r.id===req.dispatchOwner.actorId,createdAt:r.created_at.toISOString(),lastSeenAt:r.last_seen_at.toISOString(),expiresAt:r.expires_at.toISOString()}))});
  }));
  const sensitive=action=>async(req,res)=>{
    const event=action==='revoke_others'?'owner_sessions_revoked':'owner_recovery_codes';
    if(!only(req,['password','code']))return deny(req,res,event,400);
    if(!await limit(req,'mfa',req.dispatchOwner.id))return deny(req,res,event,429);
    const row=await store.dispatchOwnerById(req.dispatchOwner.id),password=req.body.password;
    const matched=await verifyPassword(passwordValid(password)?password:'invalid-owner-password',row?.password_hash);
    const at=now(),codes=recoveryCodes();
    if(!matched||!passwordValid(password)||!await store.dispatchSensitiveAction(req.dispatchOwner.sessionHash,at,row.password_hash,(cipher,last)=>totpStep(decryptSeed(cipher,key,row.id),req.body.code,at,last),action,codes.map(hashToken),audit(req,event))) {
      // A failed fresh verification does not invalidate a still-valid session.
      // Reserve 401 for an expired/revoked session, including concurrent revocation.
      return deny(req,res,event,await recheck(req)?403:401);
    }
    report(req,event,'succeeded');res.json(action==='recovery_codes'?{recoveryCodes:codes}:{ok:true});
  };
  app.post(prefix+'/sessions/revoke-others',mutation,route(requireOwner),route(sensitive('revoke_others')));
  app.post(prefix+'/recovery-codes',mutation,route(requireOwner),route(sensitive('recovery_codes')));
  app.post(prefix+'/logout',mutation,route(async(req,res)=>{await logout(req,res);res.json({ok:true});}));
  app.get(prefix+'/audit',route(requireOwner),route(async(req,res)=>{
    const keys=Object.keys(req.query);if(keys.some(k=>!['staffId','action','from','to','cursor','limit'].includes(k))||keys.some(k=>typeof req.query[k]!=='string'))return res.status(400).json({error:'Invalid audit filter.'});
    const result=await store.dispatchAuditPage({...req.query,limit:req.query.limit===undefined?25:Number(req.query.limit)});
    if(!await recheck(req))return res.status(401).json({error:'Unauthorized'});res.json(result);
  }));
  return {enabled,requireOwner,resolve,current,recheck,logout,sessionName,challengeName};
}
module.exports={installDispatchOwner,encryptionKey,encryptSeed,decryptSeed,totpStep,generateEnrollment,recoveryHash,recoveryCodes,LIMITS,SESSION_MS,IDLE_MS,CHALLENGE_MS};
