// Test-only adapter. The production implementation persists these transitions in PostgreSQL.
const crypto=require('node:crypto');
const {validSource,sameSource,createRefund,submission,outcome,validWebhook,webhookOutcome,applyRefundRecord}=require('../../storage/refunds');
const clone=value=>value?structuredClone(value):null;
const conflict=()=>Object.assign(new Error('Trip update unavailable. Please refresh and try again.'),{status:409});
function recordMemoryPayment(shared,record){
 shared.paymentLedger ||=new Map();
 if(record.paymentStatus==='paid' && typeof record.id==='string' && Number.isFinite(record.quote?.total) && !shared.paymentLedger.has(record.id))shared.paymentLedger.set(record.id,{booking_id:record.id,amount_cents:Math.round(record.quote.total*100),currency:record.quote.currency,stripe_session_id:record.stripeSessionId || null});
}
function history(shared,row,now,eventId=null){shared.refundEvents ||=new Map();const event={id:crypto.randomUUID(),refund_id:row.id,state:row.state,evidence:row.evidence,stripe_event_id:eventId,created_at:new Date(now).toISOString()};shared.refundEvents.set(event.id,event);}
function prepareMemoryRefund(shared,record,auth,event,source,now){
 shared.refunds ||=new Map();shared.paymentLedger ||=new Map();
 if(!auth || event?.booking_id!==record.id || event.customer_id!==auth.id || event.kind!=='customer_cancelled' || !validSource(record,shared.paymentLedger.get(record.id),source))throw conflict();
 let row=[...shared.refunds.values()].find(r=>r.booking_id===record.id);
 if(row){if(row.customer_id!==auth.id || !sameSource(row,source))throw conflict();applyRefundRecord(record,row);return clone(row);}
 row=createRefund(record,auth,event,source,now);shared.refunds.set(row.id,clone(row));history(shared,row,now);applyRefundRecord(record,row);return clone(row);
}
function refundMemory(shared,fail,atomic,actionScope,emails){
 shared.refunds ||=new Map();shared.refundEvents ||=new Map();shared.paymentLedger ||=new Map();
 const assert=(id,needsAction=true)=>{
  const row=clone(shared.refunds.get(id));if(!row)return null;
  const record=clone(shared.records.find(r=>r.id===row.booking_id)),owner=shared.tripRows.get(row.booking_id)?.customer_id;
  if(!record || owner!==row.customer_id || record.status!=='cancelled' || record.paymentStatus!=='paid' || !validSource(record,shared.paymentLedger.get(record.id),{sessionId:row.stripe_session_id,paymentIntentId:row.payment_intent_id,chargeId:row.charge_id,amountCents:Number(row.amount_cents),currency:row.currency}))throw conflict();
  if(needsAction && actionScope.getStore()!==(record.checkoutFingerprint || 'reservation:'+record.id))throw conflict();return {row,record};
 };
 const persist=(value,now,eventId=null,append=true)=>{
  fail('write');fail('refundWrite');if(['confirmed','failed','review_required'].includes(value.row.state))fail('emailEnqueue');
  applyRefundRecord(value.record,value.row);shared.refunds.set(value.row.id,clone(value.row));shared.records=shared.records.map(r=>r.id===value.record.id?clone(value.record):r);if(append)history(shared,value.row,now,eventId);
  if(value.record.refundStatus==='review_required'){
   for(const job of shared.bookingEmails.values())if(job.booking_id===value.record.id && ['customer_refund_confirmed','admin_refund_confirmed'].includes(job.kind) && ['pending','sending'].includes(job.state))Object.assign(job,{state:'review_required',payload:null,claim_token:null,lease_until:null,updated_at:new Date(now).toISOString()});
   const audit=shared.tripEvents.get(value.row.trip_event_id);if(!audit)throw conflict();
   for(const kind of ['customer_refund_review','admin_refund_review'])emails.enqueue(value.record,kind,{...audit,created_at:new Date(now).toISOString()});
  }
 };
 return {
  capturedPayment:async id=>{fail('read');return clone(shared.paymentLedger.get(id));},
  refundForBooking:async id=>{fail('read');return clone([...shared.refunds.values()].find(r=>r.booking_id===id));},
  refundCandidates:async(now,limit=10)=>{fail('read');if(!Number.isInteger(limit) || limit<1 || limit>100)throw conflict();return [...shared.refunds.values()].filter(r=>['prepared','submitted_unknown','provider_identified'].includes(r.state)).sort((a,b)=>a.updated_at.localeCompare(b.updated_at)||a.id.localeCompare(b.id)).slice(0,limit).map(clone);},
  startRefundSubmission:async(id,now)=>atomic(async()=>{fail('read');const value=assert(id);if(!value)return null;if(submission(value.row,now))persist(value,now);return clone(value.row);}),
  recordRefundOutcome:async(id,result,now)=>atomic(async()=>{fail('read');const value=assert(id);if(!value)return null;const prior=[value.row.state,value.row.evidence,value.row.stripe_refund_id].join('|');if(outcome(value.row,result,now))persist(value,now,null,prior!==[value.row.state,value.row.evidence,value.row.stripe_refund_id].join('|'));return clone(value.row);}),
  confirmRefundWebhook:async(event,now)=>atomic(async()=>{
   fail('read');const value=assert(event?.attemptId,false);if(!value || !validWebhook(value.row,event))return false;
   if(event.providerVerified===true)assert(event.attemptId,true);
   const previous=[...shared.refundEvents.values()].find(e=>e.stripe_event_id===event.eventId);if(previous)return previous.refund_id===value.row.id;
   if(value.row.state==='confirmed' && (event.status==='succeeded' || event.providerVerified!==true) || value.row.state==='failed' && ['pending','requires_action'].includes(event.status) && event.providerVerified!==true)return true;
   if(!webhookOutcome(value.row,event,now))return false;
   const audit=shared.tripEvents.get(value.row.trip_event_id);if(!audit || audit.booking_id!==value.row.booking_id)throw conflict();
   persist(value,now,event.eventId);
   if(value.row.state==='confirmed')for(const kind of ['customer_refund_confirmed','admin_refund_confirmed'])emails.enqueue(value.record,kind,{...audit,created_at:new Date(now).toISOString()});
   return true;
  })
 };
}
module.exports={refundMemory,prepareMemoryRefund,recordMemoryPayment};
