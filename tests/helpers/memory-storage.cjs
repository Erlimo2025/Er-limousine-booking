// Only injected by tests; never imported or selectable by the runtime server.
const {StorageError}=require('../../storage/postgres');
const clone=x=>JSON.parse(JSON.stringify(x));
function memoryStore(initial=[], shared={records:clone(initial),locks:new Map(),queue:Promise.resolve()}, failures={}) {
 shared.claims ||= new Map();
 const identity=r=>[r.customer.email.trim().toLowerCase(),r.customer.phone.replace(/\D/g,'')];
 const fail=kind=>{if(failures[kind])throw new StorageError();};
 const atomic=async fn=>{const before=shared.queue;let release;shared.queue=new Promise(r=>release=r);await before;try{return await fn();}finally{release();}};
 return {
  migrate:async()=>{fail('initialize');},close:async()=>{},
  hasPaidRide:async(email,phone)=>{fail('read');return shared.records.some(r=>r.paymentStatus==='paid' && ((email && r.customer?.email?.trim().toLowerCase()===email) || (phone && r.customer?.phone?.replace(/\D/g,'')===phone)));},
  list:async()=>{fail('read');return clone(shared.records);},
  get:async id=>{fail('read');return clone(shared.records.find(r=>r.id===id)||null);},
  update:async(id,fn)=>atomic(async()=>{fail('read');const r=clone(shared.records.find(r=>r.id===id)||null);if(!r)return null;const result=await fn(r);fail('write');if(r.paymentStatus==='paid'||(!r.checkoutAttempt&&!r.stripeSessionId))for(const [k,v]of shared.claims)if(v===id)shared.claims.delete(k);shared.records=shared.records.map(x=>x.id===id?r:x);return result===undefined?r:result;}),
  createWithBudget:async(record,check)=>atomic(async()=>{fail('read');await check(clone(shared.records));fail('write');if(shared.records.some(r=>r.id===record.id))throw new StorageError();shared.records.unshift(clone(record));return clone(record);}),
  withActionLock:async(key,fn)=>{if(shared.locks.has(key))throw Object.assign(new Error('Checkout is already processing. Please try again.'),{status:409});shared.locks.set(key,true);try{return await fn();}finally{shared.locks.delete(key);}},
  firstRideConflicts:async r=>clone(shared.records.filter(x=>x.id!==r.id && identity(r).some(k=>shared.claims.get(k)===x.id))),
  claimFirstRide:async r=>atomic(async()=>{const keys=identity(r);if(shared.records.some(x=>x.paymentStatus==='paid' && identity(x).some(k=>keys.includes(k))))throw Object.assign(new Error('FIRST15 is only available for your first ride.'),{status:400});if(keys.some(k=>shared.claims.has(k)&&shared.claims.get(k)!==r.id))throw Object.assign(new Error('A first-ride Checkout is already pending.'),{status:409});for(const k of keys)shared.claims.set(k,r.id);}),
  releaseExpiredFirstRide:async(id,session)=>atomic(async()=>{const r=shared.records.find(x=>x.id===id);if(r && r.paymentStatus!=='paid' && r.stripeSessionId===session)for(const [k,v] of shared.claims)if(v===id)shared.claims.delete(k);}),
  fixtures:records=>{shared.records=clone(records);},shared
 };
}
module.exports={memoryStore};
