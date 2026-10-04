const crypto=require('node:crypto');
const {promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt);
const SESSION_MS=30*24*60*60*1000;
const options={N:65536,r:8,p:2,maxmem:96*1024*1024};
const hashToken=token=>crypto.createHash('sha256').update(token).digest('hex');
let activeHashes=0;
async function derive(password,salt) {
 // Bound memory-heavy work; never queue an unbounded number of password jobs.
 if(activeHashes>=2)throw Object.assign(new Error('Authentication busy'),{status:503});
 activeHashes++;
 try{return await scrypt(password,salt,64,options);}finally{activeHashes--;}
}
async function hashPassword(password) {
 const salt=crypto.randomBytes(16).toString('hex');
 const key=await derive(password,salt);
 return ['scrypt','v1',options.N,options.r,options.p,salt,key.toString('hex')].join('$');
}
const dummy=['scrypt','v1',options.N,options.r,options.p,'00'.repeat(16),'00'.repeat(64)].join('$');
async function verifyPassword(password,encoded) {
 const parts=String(encoded || dummy).split('$');
 const valid=parts.length===7 && parts[0]==='scrypt' && parts[1]==='v1' &&
  parts[2]===String(options.N) && parts[3]===String(options.r) && parts[4]===String(options.p) &&
  /^[a-f0-9]{32}$/.test(parts[5]) && /^[a-f0-9]{128}$/.test(parts[6]);
 const chosen=valid ? parts : dummy.split('$');
 const actual=await derive(password,chosen[5]);
 return crypto.timingSafeEqual(actual,Buffer.from(chosen[6],'hex')) && valid && !!encoded;
}
function passwordValid(value){return typeof value==='string' && [...value].length>=10 && [...value].length<=128 && Buffer.byteLength(value,'utf8')<=512;}
function email(value) {
 if(typeof value!=='string' || value.length>254)return null;
 const trimmed=value.trim(),parts=trimmed.split('@');
 if(parts.length!==2 || parts[0].length>64 || !parts[0] || /[\s<>()[\]\\,;:"\x00-\x1f\x7f]/.test(trimmed) || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..'))return null;
 const domain=require('node:url').domainToASCII(parts[1]).toLowerCase();
 if(!domain.includes('.') || domain.length>253 || !domain.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))return null;
 return {display:trimmed,normalized:parts[0].toLowerCase()+'@'+domain};
}
function phone(value) {
 if(typeof value!=='string' || value.length>40 || !/^[+0-9().\s-]+$/.test(value) || (value.includes('+') && (!/^\s*\+/.test(value) || (value.match(/\+/g)||[]).length!==1)))return null;
 let digits=value.replace(/\D/g,'');if(digits.length===11 && digits[0]==='1')digits=digits.slice(1);
 return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? {display:value.trim(),normalized:'+1'+digits} : null;
}
const profile=c=>({fullName:c.full_name,email:c.display_email,phone:c.display_phone});
function installCustomerAuth(app,{store,route,rateLimit,validOrigin,secure,now=Date.now}) {
 const name=secure?'__Host-er_customer_session':'er_customer_session';
 const cookieOptions={httpOnly:true,secure,sameSite:'strict',path:'/'};
 function token(req) {
  const matches=String(req.headers.cookie || '').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
  if(matches.length!==1)return null;
  const value=matches[0].slice(name.length+1);return /^[A-Za-z0-9_-]{43}$/.test(value)?value:null;
 }
 const clear=res=>res.clearCookie(name,cookieOptions);
 const makeSession=()=>{const raw=crypto.randomBytes(32).toString('base64url');const created=new Date(now());return {raw,hash:hashToken(raw),created,expires:new Date(created.getTime()+SESSION_MS)};};
 const issue=(res,s)=>res.cookie(name,s.raw,{...cookieOptions,maxAge:SESSION_MS});
 const reject=(res,status,message)=>res.status(status).json({error:message});
 const auth=async(req,res,next)=>{
  const raw=token(req);req.customer=raw ? await store.resolveCustomerSession(hashToken(raw),now()) : null;
  if(!req.customer){clear(res);return req.path.startsWith('/api/')?reject(res,401,'Please log in to continue.'):res.redirect('/account.html');}
  next();
 };
 app.use(['/api/customer','/account.html','/account/dashboard'],(req,res,next)=>{res.set('Cache-Control','no-store');next();});
 app.use('/api/customer',rateLimit('customer-api',120));
 const mutation=(req,res,next)=>{
  if(!validOrigin(req) || !req.is('application/json'))return reject(res,403,'Invalid request.');
  if(!req.body || Array.isArray(req.body) || typeof req.body!=='object')return reject(res,400,'Invalid request.');next();
 };
 app.post('/api/customer/register',rateLimit('customer-register',10,15*60*1000),mutation,route(async(req,res)=>{
  const b=req.body,e=email(b.email),p=phone(b.phone);
  const fullName=typeof b.fullName==='string'?b.fullName.trim().replace(/\s+/g,' '):'';
  if(fullName.length<2 || fullName.length>120 || /[\x00-\x1f\x7f<>]/.test(fullName))return reject(res,400,'Enter a valid full name.');
  if(!e)return reject(res,400,'Enter a valid email address.');
  if(!p)return reject(res,400,'Enter a valid U.S. phone number.');
  if(!passwordValid(b.password))return reject(res,400,'Use a password between 10 and 128 characters.');
  const c={id:crypto.randomUUID(),full_name:fullName,normalized_email:e.normalized,display_email:e.display,normalized_phone:p.normalized,display_phone:p.display,password_hash:await hashPassword(b.password)};
  const s=makeSession();
  if(!await store.registerCustomer(c,s))return reject(res,400,'Unable to create an account with these details. Please log in or use different details.');
  const old=token(req);if(old)await store.revokeCustomerSession(hashToken(old));
  issue(res,s);res.status(201).json({customer:profile(c)});
 }));
 app.post('/api/customer/login',rateLimit('customer-login',30,15*60*1000),mutation,route(async(req,res)=>{
  const e=email(req.body.email),password=req.body.password;
  const identity=hashToken(e?.normalized || 'invalid-email');
  if(!await store.customerLoginLimit(identity,now()))return reject(res,429,'Too many requests. Please try again later.');
  const c=e ? await store.customerByEmail(e.normalized) : null;
  const validInput=passwordValid(password);
  const matched=await verifyPassword(validInput?password:'invalid-password-input',c?.password_hash);
  if(!validInput || !matched || c?.account_status!=='active')return reject(res,401,'Email or password is incorrect.');
  const s=makeSession();
  if(!await store.createCustomerSession(c.id,s,c.password_hash))return reject(res,401,'Email or password is incorrect.');
  const old=token(req);if(old)await store.revokeCustomerSession(hashToken(old));
  issue(res,s);res.json({customer:profile(c)});
 }));
 app.get('/api/customer/profile',route(auth),route(async(req,res)=>res.json({customer:profile(req.customer)})));
 app.get('/account/dashboard',route(auth),(req,res)=>res.sendFile(require('node:path').join(__dirname,'../public/account.html')));
 app.post('/api/customer/logout',mutation,route(async(req,res)=>{
  const raw=token(req);if(raw)await store.revokeCustomerSession(hashToken(raw));clear(res);res.json({ok:true});
 }));
}
module.exports={installCustomerAuth,hashPassword,verifyPassword,passwordValid,email,phone,hashToken,SESSION_MS};
