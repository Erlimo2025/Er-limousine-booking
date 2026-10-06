const providerId=(value,prefix)=>typeof value==='string' && new RegExp('^'+prefix+'_[A-Za-z0-9_]{1,120}$').test(value);
const reference=value=>typeof value==='string'?value:value?.id;
const unavailable=()=>Object.assign(new Error('Refund service temporarily unavailable.'),{status:503});
const options={timeout:10000,maxNetworkRetries:0};
const refundStatuses=new Set(['pending','requires_action','succeeded','failed','canceled']);
function reservationRefunds({store,stripe,now=Date.now,reportFailure=()=>{}}){
 async function capture(record){
  try{
   const ledger=await store.capturedPayment(record.id),amount=Math.round(record.quote.total*100);
   if(!stripe || record.paymentStatus!=='paid' || !ledger || ledger.stripe_session_id!==record.stripeSessionId ||
    Number(ledger.amount_cents)!==amount || ledger.currency!==record.quote.currency || !Number.isSafeInteger(amount) || amount<=0)throw unavailable();
   const session=await stripe.checkout.sessions.retrieve(ledger.stripe_session_id,{},options),piId=reference(session?.payment_intent);
   if(session?.id!==ledger.stripe_session_id || session.mode!=='payment' || session.payment_status!=='paid' || session.metadata?.bookingId!==record.id || session.amount_total!==amount || session.currency!==ledger.currency || !providerId(piId,'pi'))throw unavailable();
   const pi=await stripe.paymentIntents.retrieve(piId,{},options),chargeId=reference(pi?.latest_charge);
   if(pi?.id!==piId || pi.status!=='succeeded' || pi.amount!==amount || pi.amount_received!==amount || pi.currency!==ledger.currency || !providerId(chargeId,'ch'))throw unavailable();
   const charge=await stripe.charges.retrieve(chargeId,{},options);
   if(charge?.id!==chargeId || reference(charge.payment_intent)!==piId || charge.status!=='succeeded' || charge.paid!==true || charge.captured!==true ||
    charge.disputed!==false || charge.amount!==amount || charge.amount_captured!==amount || charge.amount_refunded!==0 || charge.refunded===true || charge.currency!==ledger.currency)throw unavailable();
   return {sessionId:session.id,paymentIntentId:piId,chargeId,amountCents:amount,currency:ledger.currency};
  }catch(_){throw unavailable();}
 }
 function matches(result,row){
  return providerId(result?.id,'re') && (!row.stripe_refund_id || result.id===row.stripe_refund_id) &&
   reference(result.charge)===row.charge_id && reference(result.payment_intent)===row.payment_intent_id &&
   result.amount===Number(row.amount_cents) && result.currency===row.currency && result.metadata?.applicationRefundId===row.id &&
   result.metadata?.bookingId===row.booking_id && refundStatuses.has(result.status);
 }
 // Caller holds the same reservation action lock used by Checkout/cancellation.
 async function submit(bookingId){
  let row=await store.refundForBooking(bookingId);
  if(!row || ['confirmed','failed','review_required'].includes(row.state))return;
  try{
   let result;
   if(row.stripe_refund_id)result=await stripe.refunds.retrieve(row.stripe_refund_id,{},options);
   else{
    row=await store.startRefundSubmission(row.id,now());
    if(!row || ['confirmed','failed','review_required'].includes(row.state))return;
    result=await stripe.refunds.create({charge:row.charge_id,amount:Number(row.amount_cents),reason:'requested_by_customer',metadata:{bookingId:row.booking_id,applicationRefundId:row.id}},
     {...options,idempotencyKey:row.idempotency_key});
   }
   if(!matches(result,row)){await store.recordRefundOutcome(row.id,{state:'review_required',evidence:'ambiguous_provider_error'},now());reportFailure();return;}
   // Even a succeeded API response is evidence only. Signed webhook is authority.
   await store.recordRefundOutcome(row.id,{state:['failed','canceled'].includes(result.status)?'failed':'provider_identified',refundId:result.id,verified:true,
    evidence:result.status==='succeeded'?'provider_succeeded_awaiting_webhook':result.status==='failed'?'provider_failed':result.status==='canceled'?'provider_canceled':'provider_pending'},now());
  }catch(_){
   // A later error never erases a prior submission or creates another identity.
   await store.recordRefundOutcome(row.id,{state:'submitted_unknown',evidence:'ambiguous_provider_error'},now());reportFailure();
  }
 }
 let running=false;
 async function run(){
  if(running || !stripe)return;running=true;
  try{
   for(const row of await store.refundCandidates(now(),10)){
    const record=await store.get(row.booking_id);if(!record)continue;
    try{await store.withActionLock(record.checkoutFingerprint || 'reservation:'+record.id,()=>submit(record.id));}
    catch(error){if(error.status!==409)reportFailure();}
   }
  }catch(_){reportFailure();}finally{running=false;}
 }
 function webhook(event){
  const r=event?.data?.object;
  if(!['refund.created','refund.updated','refund.failed'].includes(event?.type))return null;
  if(!providerId(event.id,'evt') || !providerId(r?.id,'re') || !refundStatuses.has(r?.status))return null;
  return {eventId:event.id,attemptId:r.metadata?.applicationRefundId,bookingId:r.metadata?.bookingId,refundId:r.id,
   paymentIntentId:reference(r.payment_intent),chargeId:reference(r.charge),amountCents:r.amount,currency:r.currency,status:r.status};
 }
 async function receive(wire){
  const {validWebhook}=require('../storage/refunds');
  let row=await store.refundForBooking(wire.bookingId);if(!row || !validWebhook(row,wire))return false;
  const record=await store.get(row.booking_id);if(!record)return false;
  return store.withActionLock(record.checkoutFingerprint || 'reservation:'+record.id,async()=>{
   row=await store.refundForBooking(record.id);if(!row || !validWebhook(row,wire))return false;
   let current;try{current=await stripe.refunds.retrieve(wire.refundId,{},options);}catch(_){throw unavailable();}
   if(!matches(current,row) || current.id!==wire.refundId)throw unavailable();
   // Refunds can fail after success. Verify current state under the same lock,
   // so an older signed event cannot regress a newer provider outcome.
   if(current.status!==wire.status)return true;
   return store.confirmRefundWebhook({...wire,providerVerified:true},now());
  });
 }
 return {capture,submit,run,webhook,receive};
}
module.exports={reservationRefunds};
