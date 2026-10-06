// Only injected by tests; never imported or selectable by the runtime server.
const {StorageError}=require('../../storage/postgres');
const clone=x=>JSON.parse(JSON.stringify(x));
function memoryStore(initial=[], shared={records:clone(initial),locks:new Map(),queue:Promise.resolve()}, failures={}) {
 const actionScope=new (require('node:async_hooks').AsyncLocalStorage)();
 shared.claims ||= new Map();shared.tripRows ||= new Map();
 const {tripDto}=require('../../storage/customer-trips');
 const identity=r=>[r.customer.email.trim().toLowerCase(),r.customer.phone.replace(/\D/g,'')];
 const fail=kind=>{if(failures[kind])throw new StorageError();};
 const atomic=async fn=>{const before=shared.queue;let release;shared.queue=new Promise(r=>release=r);await before;try{return await fn();}finally{release();}};
 return {
  ...require('./customer-memory.cjs').customerMemory(shared,failures),
  ...require('./payment-memory.cjs').paymentMemory(shared,failures),
  migrate:async()=>{fail('initialize');},close:async()=>{},
  hasPaidRide:async(email,phone)=>{fail('read');return shared.records.some(r=>r.paymentStatus==='paid' && ((email && r.customer?.email?.trim().toLowerCase()===email) || (phone && r.customer?.phone?.replace(/\D/g,'')===phone)));},
  list:async()=>{fail('read');return clone(shared.records);},
  get:async id=>{fail('read');return clone(shared.records.find(r=>r.id===id)||null);},
  update:async(id,fn)=>atomic(async()=>{fail('read');const r=clone(shared.records.find(r=>r.id===id)||null);if(!r)return null;const priorStatus=r.status;const result=await fn(r);if(priorStatus!=='cancelled'&&r.status==='cancelled'&&actionScope.getStore()!==(r.checkoutFingerprint || 'reservation:'+r.id))throw Object.assign(new Error('Checkout is already processing. Please try again.'),{status:409});fail('write');if(r.paymentStatus==='paid'||(r.deferredPayment&&r.status==='cancelled'&&(r.checkoutAttempt?.state==='confirmed_unpaid'||(!r.stripeSessionId&&(!r.checkoutAttempt||r.checkoutAttempt.version===1&&r.checkoutAttempt.firstSubmittedAt===null&&r.checkoutAttempt.submissionCount===0))))||(!r.deferredPayment&&(r.checkoutAttempt?.state==='confirmed_unpaid'||(!r.checkoutAttempt&&!r.stripeSessionId))))for(const [k,v]of shared.claims)if(v===id)shared.claims.delete(k);shared.records=shared.records.map(x=>x.id===id?r:x);return result===undefined?r:result;}),
  createWithBudget:async(record,check,association={})=>atomic(async()=>{fail('read');await check(clone(shared.records));fail('write');if(shared.records.some(r=>r.id===record.id))throw new StorageError();if(record.deferredPayment && record.quote.promotion?.code==='FIRST15'){const keys=identity(record);if(shared.records.some(x=>x.paymentStatus==='paid'&&identity(x).some(k=>keys.includes(k))))throw Object.assign(new Error('FIRST15 unavailable'),{status:400});if(keys.some(k=>shared.claims.has(k)&&shared.claims.get(k)!==record.id))throw Object.assign(new Error('FIRST15 pending'),{status:409});for(const k of keys)shared.claims.set(k,record.id);}shared.records.unshift(clone(record));const session=shared.customerSessions.get(association.sessionHash),customer=shared.customers.get(association.customerId);
    shared.tripRows.set(record.id,{customer_id:session?.customer_id===association.customerId && session.expires>association.now && customer?.account_status==='active'?association.customerId:null,start:association.start?new Date(association.start).toISOString():null,end:association.end?new Date(association.end).toISOString():null});return clone(record);}),
  withActionLock:async(key,fn)=>{if(shared.locks.has(key))throw Object.assign(new Error('Checkout is already processing. Please try again.'),{status:409});shared.locks.set(key,true);try{return await actionScope.run(key,fn);}finally{shared.locks.delete(key);}},
  firstRideConflicts:async r=>clone(shared.records.filter(x=>x.id!==r.id && identity(r).some(k=>shared.claims.get(k)===x.id))),
  claimFirstRide:async r=>atomic(async()=>{const keys=identity(r);if(shared.records.some(x=>x.paymentStatus==='paid' && identity(x).some(k=>keys.includes(k))))throw Object.assign(new Error('FIRST15 is only available for your first ride.'),{status:400});if(keys.some(k=>shared.claims.has(k)&&shared.claims.get(k)!==r.id))throw Object.assign(new Error('A first-ride Checkout is already pending.'),{status:409});for(const k of keys)shared.claims.set(k,r.id);}),
  releaseExpiredFirstRide:async(id,session)=>atomic(async()=>{const r=shared.records.find(x=>x.id===id);if(r && !r.deferredPayment && r.paymentStatus!=='paid' && r.stripeSessionId===session)for(const [k,v] of shared.claims)if(v===id)shared.claims.delete(k);}),
  reconciliationCandidates:async limit=>{fail('read');return clone(shared.records.filter(r=>r.paymentStatus!=='paid' && (!r.deferredPayment||r.stripeSessionId||r.checkoutAttempt?.firstSubmittedAt!=null) && [...shared.claims.values()].includes(r.id)).sort((a,b)=>(a.checkoutAttempt?.lastReconciledAt || 0)-(b.checkoutAttempt?.lastReconciledAt || 0)).slice(0,limit));},
  abandonedDeferredCandidates:async(now,limit)=>clone(shared.records.filter(r=>r.deferredPayment&&r.quote.promotion?.code==='FIRST15'&&r.paymentStatus!=='paid'&&r.status!=='cancelled'&&(r.checkoutAttempt?.state==='confirmed_unpaid'||(!r.stripeSessionId&&(!r.checkoutAttempt||r.checkoutAttempt.firstSubmittedAt===null&&r.checkoutAttempt.submissionCount===0)))&&Date.parse(r.createdAt)<=now-24*3600000).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,limit)),
  finalizeReconciliation:async(snapshot,outcome)=>atomic(async()=>{
   fail('read');const r=clone(shared.records.find(x=>x.id===snapshot.id)||null),a=r?.checkoutAttempt;
   if(!a || a.key!==snapshot.checkoutAttempt?.key || (r.stripeSessionId||null)!==(snapshot.stripeSessionId||null) || (a.state||null)!==(snapshot.checkoutAttempt.state||null))return false;
   if(r.paymentStatus==='paid')return false;
   if(outcome.state==='confirmed_unpaid' && (shared.records.some(x=>x.paymentStatus==='paid' && identity(x).some(k=>identity(r).includes(k))) || ![...shared.claims.values()].includes(r.id)))return false;
   if(outcome.sessionId)r.stripeSessionId=outcome.sessionId;
   Object.assign(a,{state:outcome.state,evidence:outcome.evidence,lastReconciledAt:outcome.at});
   if(outcome.state==='confirmed_paid')Object.assign(a,{state:'session_identified',evidence:'verified_paid_awaiting_webhook'});
   fail('write');shared.records=shared.records.map(x=>x.id===r.id?r:x);
   if((!r.deferredPayment||r.status==='cancelled')&&outcome.state==='confirmed_unpaid')for(const [k,v]of shared.claims)if(v===r.id)shared.claims.delete(k);
   return true;
  }),
  customerReservation:async(customerId,id)=>{fail('read');return clone(shared.tripRows.get(id)?.customer_id===customerId?shared.records.find(x=>x.id===id)||null:null);},
  reservationOwner:async id=>{fail('read');return shared.tripRows.get(id)?.customer_id || null;},
  customerTrip:async(customerId,id)=>{fail('read');const r=shared.records.find(x=>x.id===id);return r && shared.tripRows.get(id)?.customer_id===customerId?tripDto(clone(r)):null;},
  customerTrips:async(customerId,q)=>{fail('read');const upcoming=q.view==='upcoming';
    const rows=shared.records.filter(r=>{const m=shared.tripRows.get(r.id);if(m?.customer_id!==customerId||!m.end)return false;const future=m.end>q.at;return upcoming?future:!future;})
      .map(r=>({r,end:shared.tripRows.get(r.id).end})).sort((a,b)=>(a.end.localeCompare(b.end)||a.r.id.localeCompare(b.r.id))*(upcoming?1:-1))
      .filter(({r,end})=>!q.cursor || (upcoming?end>q.cursor.schedule || end===q.cursor.schedule&&r.id>q.cursor.id:end<q.cursor.schedule || end===q.cursor.schedule&&r.id<q.cursor.id));
    const page=rows.slice(0,q.limit),last=page.at(-1);return {trips:page.map(x=>tripDto(clone(x.r))),nextCursor:rows.length>q.limit?Buffer.from(JSON.stringify({view:q.view,at:q.at,schedule:last.end,id:last.r.id})).toString('base64url'):null};},
  fixtures:records=>{shared.records=clone(records);},shared
 };
}
module.exports={memoryStore};
