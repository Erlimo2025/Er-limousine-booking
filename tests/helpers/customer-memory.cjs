// Test-only adapter; production always uses PostgreSQL.
const crypto=require('node:crypto');
function customerMemory(shared,failures={}) {
 shared.customers ||= new Map();shared.customerSessions ||= new Map();shared.customerLimits ||= new Map();
 shared.enrollments ||= new Map();
 shared.enrollmentSends ||= new Map();
 shared.enrollmentSources ||= new Map();
 shared.emailVerificationChallenges ||= new Map();
 const clone=x=>x?structuredClone(x):null;
 const fail=()=>{if(failures.read||failures.write)throw Object.assign(new Error('private-storage-marker'),{storageFailure:true});};
 const conflict=(email,phone)=>[...shared.customers.values()].some(c=>c.normalized_email===email||c.normalized_phone===phone);
 const recordAttempt=(source,now)=>{
  const recent=(shared.enrollmentSources.get(source)||[]).filter(time=>time>now-3600000);
  shared.enrollmentSources.set(source,recent);
  if(recent.length>=20)return false;
  recent.push(now);
  return true;
 };
 const recordSend=(email,now)=>{
  const recent=(shared.enrollmentSends.get(email)||[]).filter(time=>time>now-3600000);
  shared.enrollmentSends.set(email,recent);
  if(recent.length>=3||recent.some(time=>time>now-60000))return false;
  recent.push(now);
  return true;
 };
 const validEnrollment=(entry,now)=>entry&&entry.expiresAt>now&&entry.maxUntil>now;
 const activeLegacy=(customerId,sessionHash,now)=>{
  const customer=shared.customers.get(customerId), session=shared.customerSessions.get(sessionHash);
  return customer?.account_status==='active'&&!customer.email_verified_at&&session?.customer_id===customerId&&
    session.expires>now?customer:null;
 };
 return {
  updateCustomerProfile:async(id,hash,changes,now)=>{fail();const c=shared.customers.get(id),s=shared.customerSessions.get(hash);if(c?.account_status!=='active'||s?.customer_id!==id||s.expires<=now)return null;
   if(changes.phone&&[...shared.customers.values()].some(x=>x.id!==id&&x.normalized_phone===changes.phone.normalized))throw Object.assign(new Error('Unable to update profile with these details.'),{status:400});
   if(changes.fullName!==undefined)c.full_name=changes.fullName;if(changes.phone){c.normalized_phone=changes.phone.normalized;c.display_phone=changes.phone.display;}return clone(c);
  },
  ...require('./recovery-memory.cjs').recoveryMemory(shared,failures),
  customerByEmail:async email=>{fail();return clone([...shared.customers.values()].find(c=>c.normalized_email===email));},
  registerCustomer:async(c,s)=>{fail();if([...shared.customers.values()].some(x=>x.normalized_email===c.normalized_email||x.normalized_phone===c.normalized_phone))return false;shared.customers.set(c.id,{...c,account_status:'active'});shared.customerSessions.set(s.hash,{customer_id:c.id,expires:s.expires.getTime()});return true;},
  prepareEnrollment:async(pending,source,now)=>{
   fail();
   if(!recordAttempt(source,now)||!recordSend(pending.normalizedEmail,now)||conflict(pending.normalizedEmail,null))return null;
   // The memory adapter exercises HTTP behavior. PostgreSQL tests cover the
   // persistent issuance, rotation and concurrency invariants.
   shared.enrollments.set(pending.tokenHash,{...pending,expiresAt:now+1200000,maxUntil:now+1800000,attempts:0});
   return pending.displayEmail;
  },
  resendEnrollment:async({browserHash,tokenHash},source,now)=>{
   fail();
   if(!recordAttempt(source,now))return null;
   const previous=[...shared.enrollments.values()].find(item=>item.browserHash===browserHash);
   if(!previous||previous.maxUntil<=now||!recordSend(previous.normalizedEmail,now)||conflict(previous.normalizedEmail,null))return null;
   shared.enrollments.delete(previous.tokenHash);
   shared.enrollments.set(tokenHash,{...previous,tokenHash,sent:false,expiresAt:Math.min(now+1200000,previous.maxUntil)});
   return previous.displayEmail;
  },
  finishEnrollmentDelivery:async(tokenHash,sent)=>{fail();const entry=shared.enrollments.get(tokenHash);if(entry)entry.sent=sent;},
  enrollmentForConfirmation:async(tokenHash,now)=>{
   fail();
   const entry=shared.enrollments.get(tokenHash);
   if(!validEnrollment(entry,now)||entry.sent!==true||entry.attempts>=8)return null;
   entry.attempts++;
   return {browserHash:entry.browserHash,passwordHash:entry.passwordHash};
  },
  activateEnrollment:async(tokenHash,session,now)=>{
   fail();
   const entry=shared.enrollments.get(tokenHash);
   if(!validEnrollment(entry,now)||entry.sent!==true)return null;
   shared.enrollments.delete(tokenHash);
   if(conflict(entry.normalizedEmail,entry.normalizedPhone))return {conflict:true};
   const customer={id:crypto.randomUUID(),full_name:entry.fullName,normalized_email:entry.normalizedEmail,
    display_email:entry.displayEmail??entry.normalizedEmail,normalized_phone:entry.normalizedPhone,display_phone:entry.displayPhone??entry.normalizedPhone,
    account_status:'active',email_verified_at:new Date(now),password_hash:entry.passwordHash};
   shared.customers.set(customer.id,customer);
   shared.customerSessions.set(session.hash,{customer_id:customer.id,expires:session.expires.getTime()});
   return {customer:clone(customer)};
  },
  prepareExistingVerification:async({customerId,sessionHash,tokenHash},source,now)=>{
   fail();
   const customer=activeLegacy(customerId,sessionHash,now);
   if(!customer||!recordAttempt(source,now)||!recordSend(customer.normalized_email,now))return null;
   shared.emailVerificationChallenges.set(customerId,{tokenHash,normalizedEmail:customer.normalized_email,expiresAt:now+1200000});
   return customer.display_email;
  },
  finishExistingVerificationDelivery:async(tokenHash,sent)=>{
   fail();
   const entry=[...shared.emailVerificationChallenges.values()].find(item=>item.tokenHash===tokenHash);
   if(entry)entry.sent=sent;
  },
  activateExistingVerification:async({customerId,sessionHash,tokenHash},now)=>{
   fail();
   const customer=activeLegacy(customerId,sessionHash,now), entry=shared.emailVerificationChallenges.get(customerId);
   if(!customer||entry?.tokenHash!==tokenHash||entry.normalizedEmail!==customer.normalized_email||entry.expiresAt<=now||entry.sent!==true)return null;
   shared.emailVerificationChallenges.delete(customerId);
   customer.email_verified_at=new Date(now);
   return clone(customer);
  },
  cleanupEmailEnrollments:async now=>{
   for(const [id,entry] of shared.enrollments)if(entry.maxUntil<=now)shared.enrollments.delete(id);
   for(const [id,entry] of shared.emailVerificationChallenges)if(entry.expiresAt<=now)shared.emailVerificationChallenges.delete(id);
  },
  createCustomerSession:async(id,s,expectedPasswordHash)=>{fail();if(shared.customers.get(id)?.account_status!=='active'||shared.customers.get(id)?.password_hash!==expectedPasswordHash)return false;shared.customerSessions.set(s.hash,{customer_id:id,expires:s.expires.getTime()});return true;},
  resolveCustomerSession:async(hash,now)=>{fail();const s=shared.customerSessions.get(hash),c=s&&shared.customers.get(s.customer_id);return s&&s.expires>now&&c?.account_status==='active'?clone(c):null;},
  revokeCustomerSession:async hash=>{fail();shared.customerSessions.delete(hash);},
  customerLoginLimit:async(hash,now)=>{fail();let counter=shared.customerLimits.get(hash);if(!counter||counter.reset<=now){counter={count:0,reset:now+900000};shared.customerLimits.set(hash,counter);}return ++counter.count<=20;}
 };
}
module.exports={customerMemory};
