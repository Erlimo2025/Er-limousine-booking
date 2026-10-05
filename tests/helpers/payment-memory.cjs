// Test-only equivalent of the PostgreSQL payment mapping/attempt contracts.
const crypto=require('node:crypto');
const {paymentError}=require('../../services/customer-payments');
const {policies}=require('../../storage/customer-payments');
function paymentMemory(shared,failures={}) {
 let nextCleanupAt=0;
 shared.paymentMappings ||= new Map();shared.paymentSetups ||= new Map();shared.paymentLimits ||= new Map();
 const clone=x=>x?structuredClone(x):null;
 const fail=()=>{if(failures.read||failures.write)throw Object.assign(new Error('synthetic private storage failure'),{storageFailure:true});};
 const authority=(owner,hash,now)=>{fail();const c=shared.customers.get(owner),s=shared.customerSessions.get(hash);if(c?.account_status!=='active'||s?.customer_id!==owner||s.expires<=now)throw paymentError(401);};
 return {
  paymentAuthority:async(...args)=>authority(...args),
  paymentLimit:async(owner,ip,op,now)=>{
   fail();const [customer,client,window]=policies[op];let allowed=true;
   if(now>=nextCleanupAt){nextCleanupAt=now+30000;const expired=[...shared.paymentLimits.entries()].filter(([,r])=>r.reset<=now).sort((a,b)=>a[1].reset-b[1].reset).slice(0,100);for(const [key]of expired)shared.paymentLimits.delete(key);}
   for(const [kind,value,max]of [['customer',owner,customer],['client',ip,client]]){const key=crypto.createHash('sha256').update(op+'|'+kind+'|'+value).digest('hex');let row=shared.paymentLimits.get(key);if(!row||row.reset<=now){row={attempts:0,reset:now+window};shared.paymentLimits.set(key,row);}allowed=++row.attempts<=max && allowed;}return allowed;
  },
  paymentMapping:async owner=>{fail();return clone(shared.paymentMappings.get(owner));},
  preparePaymentMapping:async(owner,hash,now)=>{authority(owner,hash,now);if(!shared.paymentMappings.has(owner))shared.paymentMappings.set(owner,{customer_id:owner,stripe_customer_id:null,provisioning_id:crypto.randomUUID(),state:'prepared',livemode:null,first_submitted_at:null,created_at:new Date(now),updated_at:new Date(now),last_setup_at:null});return clone(shared.paymentMappings.get(owner));},
  updatePaymentMapping:async(owner,hash,expected,state,now,result)=>{
   authority(owner,hash,now);const row=shared.paymentMappings.get(owner);if(!row||row.provisioning_id!==expected.provisioning_id||row.state!==expected.state||row.stripe_customer_id!==expected.stripe_customer_id||row.state==='ready')throw paymentError();
   if(state==='ready'&&failures.paymentMappingSave)throw Object.assign(new Error('synthetic private rollback'),{storageFailure:true});
   Object.assign(row,{state,updated_at:new Date(now),stripe_customer_id:result?.id||null,livemode:result?.livemode??null});if(state==='submitted_unknown')row.first_submitted_at ||= new Date(now);return clone(row);
  },
  preparePaymentSetup:async(owner,hash,now)=>{
   authority(owner,hash,now);const m=shared.paymentMappings.get(owner);if(m?.state!=='ready')throw paymentError();const active=[...shared.paymentSetups.values()].find(a=>a.customer_id===owner&&['prepared','submitted_unknown','identified','review_required'].includes(a.state));if(active)return clone(active);
   if(m.last_setup_at&&now-new Date(m.last_setup_at).getTime()<60000)throw paymentError(429);
   const a={id:crypto.randomUUID(),customer_id:owner,stripe_setup_id:null,state:'prepared',consent_at:new Date(now),created_at:new Date(now),updated_at:new Date(now),expires_at:new Date(now+1800000),first_submitted_at:null};shared.paymentSetups.set(a.id,a);m.last_setup_at=new Date(now);return clone(a);
  },
  paymentSetup:async(owner,id)=>{fail();const a=shared.paymentSetups.get(id);return a?.customer_id===owner?clone(a):null;},
  updatePaymentSetup:async(owner,hash,expected,state,now,setupId=expected.stripe_setup_id)=>{
   authority(owner,hash,now);const row=shared.paymentSetups.get(expected.id);if(!row||row.customer_id!==owner||row.state!==expected.state||row.stripe_setup_id!==expected.stripe_setup_id||(row.stripe_setup_id&&row.stripe_setup_id!==setupId))throw paymentError();
   if(state==='identified'&&failures.paymentSetupSave)throw Object.assign(new Error('synthetic private rollback'),{storageFailure:true});
   Object.assign(row,{state,stripe_setup_id:setupId,updated_at:new Date(now)});if(state==='submitted_unknown')row.first_submitted_at ||= new Date(now);return clone(row);
  }
 };
}
module.exports={paymentMemory};
