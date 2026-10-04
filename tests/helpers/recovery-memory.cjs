// Test-only recovery adapter, mirroring transaction boundaries without production fallback.
const crypto=require('node:crypto');
function recoveryMemory(shared,failures={}) {
 shared.recovery ||= new Map();shared.recoveryLimits ||= new Map();
 const fail=()=>{if(failures.read||failures.write)throw Object.assign(new Error('synthetic private storage marker'),{storageFailure:true});};
 const limit=(scope,hash,now,max)=>{const key=scope+':'+hash;let r=shared.recoveryLimits.get(key);if(!r||r.reset<=now){r={count:0,reset:now+3600000,last:r?.last};shared.recoveryLimits.set(key,r);}r.count++;return r.count<=max&&(scope!=='email'||!r.last||r.last+60000<=now);};
 return {
  prepareRecovery:async(record,email,clientHash,now)=>{
   fail();const ip=limit('client',clientHash,now,20),ok=limit('email',record.identity_hash,now,3);
   if(!ip||!ok)return {prepared:false};
   shared.recoveryLimits.get('email:'+record.identity_hash).last=now;
   const c=[...shared.customers.values()].find(c=>c.normalized_email===email&&c.account_status==='active');
   shared.recovery.set(record.challenge_hash,{...record,method:'email_link',code_verifier:null,customer_id:c?.id||null,created_at:now,expires_at:now+600000,failed_attempts:0,delivery_state:c?'pending':'sent'});return {prepared:true,email:c?.display_email||null};
  },
  finishRecoveryDelivery:async(hash,ok)=>{fail();const r=shared.recovery.get(hash);if(r&&r.delivery_state==='pending')r.delivery_state=ok?'sent':'failed';},
  exchangeRecovery:async(hash,resetHash,now)=>{
   fail();const r=[...shared.recovery.values()].find(r=>r.email_token_hash===hash&&r.method==='email_link');
   const c=r&&shared.customers.get(r.customer_id);
   if(!r||!c||c.account_status!=='active'||r.consumed_at||r.verified_at||r.expires_at<=now||r.delivery_state!=='sent')return false;
   r.verified_at=now;r.reset_hash=resetHash;return {expiresAt:r.expires_at};
  },
  recoveryGrant:async(hash,now)=>{fail();return [...shared.recovery.values()].some(r=>r.method==='email_link'&&r.reset_hash===hash&&r.verified_at&&!r.consumed_at&&r.expires_at>now);},
  resetCustomerPassword:async(hash,passwordHash,now)=>{
   fail();const r=[...shared.recovery.values()].find(r=>r.reset_hash===hash),c=r&&shared.customers.get(r.customer_id);
   if(!r||r.method!=='email_link'||!c||c.account_status!=='active'||!r.verified_at||r.consumed_at||r.expires_at<=now)return false;
   c.password_hash=passwordHash;
   for(const [key,s]of shared.customerSessions)if(s.customer_id===c.id)shared.customerSessions.delete(key);
   for(const challenge of shared.recovery.values())if(challenge.customer_id===c.id&&!challenge.consumed_at){challenge.consumed_at=now;challenge.reset_hash=null;}return true;
  }
 };
}
module.exports={recoveryMemory};
