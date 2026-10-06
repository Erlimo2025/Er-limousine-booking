const crypto=require('node:crypto');
const {enqueueBookingEmail}=require('./booking-emails');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const providerId=(value,prefix)=>typeof value==='string' && new RegExp('^'+prefix+'_[A-Za-z0-9_]{1,180}$').test(value);
const evidenceValues=new Set(['prepared','submitted','provider_pending','provider_succeeded_awaiting_webhook','provider_failed','provider_canceled','ambiguous_provider_error','idempotency_window_expired','webhook_pending','webhook_confirmed','webhook_failed','webhook_canceled']);
const unavailable=()=>Object.assign(new Error('Refund service temporarily unavailable. Please try again.'),{status:503,storageFailure:true});
const conflict=()=>Object.assign(new Error('Trip update unavailable. Please refresh and try again.'),{status:409});
const epoch=value=>value===null || value===undefined?NaN:new Date(value).getTime();
function validSource(record,ledger,source){
 return record.paymentStatus==='paid' && record.status==='cancelled' && ledger && source &&
  providerId(source.sessionId,'cs') && source.sessionId===record.stripeSessionId && source.sessionId===ledger.stripe_session_id &&
  providerId(source.paymentIntentId,'pi') && providerId(source.chargeId,'ch') &&
  Number.isSafeInteger(source.amountCents) && source.amountCents>0 && source.amountCents===Number(ledger.amount_cents) &&
  source.amountCents===Math.round(record.quote.total*100) && source.currency==='usd' && source.currency===ledger.currency && source.currency===record.quote.currency;
}
function sameSource(row,source){return row.stripe_session_id===source.sessionId && row.payment_intent_id===source.paymentIntentId && row.charge_id===source.chargeId && Number(row.amount_cents)===source.amountCents && row.currency===source.currency;}
function createRefund(record,auth,event,source,now){
 const id=crypto.randomUUID(),at=new Date(now).toISOString();
 return {id,booking_id:record.id,customer_id:auth.id,trip_event_id:event.id,stripe_session_id:source.sessionId,payment_intent_id:source.paymentIntentId,charge_id:source.chargeId,amount_cents:source.amountCents,currency:source.currency,idempotency_key:'er-refund-'+id,state:'prepared',stripe_refund_id:null,first_submitted_at:null,submission_count:0,evidence:'prepared',created_at:at,updated_at:at,confirmed_at:null};
}
function submission(row,now){
 if(['confirmed','failed','review_required'].includes(row.state))return false;
 if(!row.stripe_refund_id && row.first_submitted_at && now-epoch(row.first_submitted_at)>=23*3600000){row.state='review_required';row.evidence='idempotency_window_expired';row.updated_at=new Date(now).toISOString();return true;}
 row.first_submitted_at ||=new Date(now).toISOString();row.submission_count++;
 if(!row.stripe_refund_id)row.state='submitted_unknown';
 row.evidence='submitted';row.updated_at=new Date(now).toISOString();return true;
}
function outcome(row,result,now){
 if(row.state==='confirmed')return false;
 if(!result || !['submitted_unknown','provider_identified','review_required','failed'].includes(result.state) || !evidenceValues.has(result.evidence))throw conflict();
 if(result.refundId!==undefined && !providerId(result.refundId,'re'))throw conflict();
 if(row.stripe_refund_id && result.refundId && row.stripe_refund_id!==result.refundId)throw conflict();
 if(result.state==='provider_identified' && !(result.refundId || row.stripe_refund_id))throw conflict();
 // A later provider error cannot erase an earlier submitted/unknown outcome.
 const conclusiveFailure=result.state==='failed' && result.verified===true && !!(result.refundId || row.stripe_refund_id);
 if(['failed','review_required'].includes(row.state) && result.state==='submitted_unknown')return false;
 if(row.state==='failed' && !conclusiveFailure)return false;
 if(result.refundId)row.stripe_refund_id=result.refundId;
 row.state=result.state==='submitted_unknown' && row.stripe_refund_id?'provider_identified':result.state==='failed' && !conclusiveFailure?'review_required':result.state;
 row.evidence=result.evidence;row.updated_at=new Date(now).toISOString();return true;
}
function validWebhook(row,event){
 return event && event.attemptId===row.id && event.bookingId===row.booking_id && providerId(event.eventId,'evt') && providerId(event.refundId,'re') &&
  (!row.stripe_refund_id || row.stripe_refund_id===event.refundId) && event.paymentIntentId===row.payment_intent_id &&
  event.chargeId===row.charge_id && event.amountCents===Number(row.amount_cents) && event.currency===row.currency &&
  ['pending','requires_action','succeeded','failed','canceled'].includes(event.status);
}
function webhookOutcome(row,event,now){
 if(!validWebhook(row,event) || row.state==='confirmed' && event.providerVerified!==true || row.state==='failed' && ['pending','requires_action'].includes(event.status) && event.providerVerified!==true)return false;
 row.stripe_refund_id=event.refundId;row.state=event.status==='succeeded'?'confirmed':['failed','canceled'].includes(event.status)?'failed':'provider_identified';
 row.evidence=event.status==='succeeded'?'webhook_confirmed':event.status==='failed'?'webhook_failed':event.status==='canceled'?'webhook_canceled':'webhook_pending';
 row.updated_at=new Date(now).toISOString();if(row.state==='confirmed')row.confirmed_at ||=new Date(now).toISOString();return true;
}
function applyRefundRecord(record,row){
 record.refundStatus=row.state==='confirmed'?'confirmed':['review_required','failed'].includes(row.state)?'review_required':'processing';
 if(row.state==='confirmed' && row.confirmed_at)record.refundConfirmedAt=new Date(row.confirmed_at).toISOString();else delete record.refundConfirmedAt;
 if(record.refundStatus==='review_required')record.paymentReviewRequired=true;
}
async function appendEvidence(client,row,now,eventId=null){
 await client.query('INSERT INTO er_reservation_refund_events(id,refund_id,state,evidence,stripe_event_id,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (stripe_event_id) WHERE stripe_event_id IS NOT NULL DO NOTHING',[crypto.randomUUID(),row.id,row.state,row.evidence,eventId,new Date(now)]);
}
async function prepareRefund(client,record,auth,event,source,now){
 if(!auth || !uuid.test(auth.id || '') || event?.booking_id!==record.id || event.customer_id!==auth.id || event.kind!=='customer_cancelled' || !Number.isFinite(epoch(now)))throw conflict();
 const ledger=(await client.query('SELECT booking_id,amount_cents,currency,stripe_session_id FROM er_payment_ledger WHERE booking_id=$1 FOR SHARE',[record.id])).rows[0];
 if(!validSource(record,ledger,source))throw conflict();
 let row=(await client.query('SELECT * FROM er_reservation_refunds WHERE booking_id=$1 FOR UPDATE',[record.id])).rows[0];
 if(row){if(row.customer_id!==auth.id || !sameSource(row,source))throw conflict();applyRefundRecord(record,row);return row;}
 row=createRefund(record,auth,event,source,now);
 await client.query('INSERT INTO er_reservation_refunds(id,booking_id,customer_id,trip_event_id,stripe_session_id,payment_intent_id,charge_id,amount_cents,currency,idempotency_key,state,evidence,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)',[row.id,row.booking_id,row.customer_id,row.trip_event_id,row.stripe_session_id,row.payment_intent_id,row.charge_id,row.amount_cents,row.currency,row.idempotency_key,row.state,row.evidence,new Date(now)]);
 await appendEvidence(client,row,now);applyRefundRecord(record,row);return row;
}
function refundStorage(pool,transaction,validateRecord,assertActionLock,queryClient=()=>pool){
 const read=async fn=>{try{return await fn();}catch(error){if(error.status)throw error;throw unavailable();}};
 async function locked(client,id,needsAction=true){
  if(typeof id!=='string' || !uuid.test(id))throw conflict();
  const found=(await client.query('SELECT booking_id FROM er_reservation_refunds WHERE id=$1',[id])).rows[0];if(!found)return null;
  await client.query('SELECT pg_advisory_xact_lock($1)',[730903]);
  const reservation=(await client.query('SELECT record,customer_id FROM er_reservations WHERE id=$1 FOR UPDATE',[found.booking_id])).rows[0];
  const row=(await client.query('SELECT * FROM er_reservation_refunds WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!reservation || !row)throw conflict();
  const record=validateRecord(reservation.record);
  if(needsAction)await assertActionLock(record.checkoutFingerprint || 'reservation:'+record.id);
  if(reservation.customer_id!==row.customer_id || record.status!=='cancelled' || record.paymentStatus!=='paid' || record.stripeSessionId!==row.stripe_session_id || Math.round(record.quote.total*100)!==Number(row.amount_cents) || record.quote.currency!==row.currency)throw conflict();
  const ledger=(await client.query('SELECT booking_id,amount_cents,currency,stripe_session_id FROM er_payment_ledger WHERE booking_id=$1 FOR SHARE',[row.booking_id])).rows[0];
  if(!validSource(record,ledger,{sessionId:row.stripe_session_id,paymentIntentId:row.payment_intent_id,chargeId:row.charge_id,amountCents:Number(row.amount_cents),currency:row.currency}))throw conflict();
  return {row,record};
 }
 async function persist(client,row,record,now,eventId=null,append=true){
  applyRefundRecord(record,row);validateRecord(record);
  await client.query('UPDATE er_reservation_refunds SET state=$2,stripe_refund_id=$3,first_submitted_at=$4,submission_count=$5,evidence=$6,updated_at=$7,confirmed_at=$8 WHERE id=$1',[row.id,row.state,row.stripe_refund_id,row.first_submitted_at,row.submission_count,row.evidence,new Date(now),row.confirmed_at]);
  await client.query('UPDATE er_reservations SET record=$2::jsonb,version=version+1,updated_at=$3 WHERE id=$1',[record.id,JSON.stringify(record),new Date(now)]);
  if(append)await appendEvidence(client,row,now,eventId);
  if(record.refundStatus==='review_required'){
   // Stop retrying an obsolete completion notice; delivered mail remains history.
   await client.query("UPDATE er_booking_email_outbox SET state='review_required',payload=NULL,claim_token=NULL,lease_until=NULL,updated_at=$2 WHERE booking_id=$1 AND kind IN ('customer_refund_confirmed','admin_refund_confirmed') AND state IN ('pending','sending')",[record.id,new Date(now)]);
   const audit=(await client.query('SELECT * FROM er_customer_trip_events WHERE id=$1 AND booking_id=$2',[row.trip_event_id,row.booking_id])).rows[0];if(!audit)throw conflict();
   for(const kind of ['customer_refund_review','admin_refund_review'])await enqueueBookingEmail(client,record,kind,{...audit,created_at:new Date(now)});
  }
 }
 return {
  capturedPayment:bookingId=>read(async()=>typeof bookingId==='string'&&uuid.test(bookingId)?(await queryClient().query('SELECT booking_id,amount_cents,currency,stripe_session_id FROM er_payment_ledger WHERE booking_id=$1',[bookingId])).rows[0] || null:null),
  refundForBooking:bookingId=>read(async()=>typeof bookingId==='string'&&uuid.test(bookingId)?(await queryClient().query('SELECT * FROM er_reservation_refunds WHERE booking_id=$1',[bookingId])).rows[0] || null:null),
  refundCandidates:(now,limit=10)=>read(async()=>{if(!Number.isFinite(epoch(now)) || !Number.isInteger(limit) || limit<1 || limit>100)throw conflict();return (await queryClient().query("SELECT * FROM er_reservation_refunds WHERE state IN ('prepared','submitted_unknown','provider_identified') ORDER BY updated_at,id LIMIT $1",[limit])).rows;}),
  startRefundSubmission:(id,now)=>transaction(async client=>{const value=await locked(client,id);if(!value)return null;if(submission(value.row,now))await persist(client,value.row,value.record,now);return value.row;}),
  recordRefundOutcome:(id,result,now)=>transaction(async client=>{const value=await locked(client,id);if(!value)return null;const prior=[value.row.state,value.row.evidence,value.row.stripe_refund_id].join('|');if(outcome(value.row,result,now))await persist(client,value.row,value.record,now,null,prior!==[value.row.state,value.row.evidence,value.row.stripe_refund_id].join('|'));return value.row;}),
  confirmRefundWebhook:(event,now)=>transaction(async client=>{
   if(!event || typeof event.attemptId!=='string' || !uuid.test(event.attemptId))return false;
   const value=await locked(client,event.attemptId,false);if(!value || !validWebhook(value.row,event))return false;
   if(event.providerVerified===true)await assertActionLock(value.record.checkoutFingerprint || 'reservation:'+value.record.id);
   const previous=(await client.query('SELECT refund_id FROM er_reservation_refund_events WHERE stripe_event_id=$1',[event.eventId])).rows[0];if(previous)return previous.refund_id===value.row.id;
   if(value.row.state==='confirmed' && (event.status==='succeeded' || event.providerVerified!==true) || value.row.state==='failed' && ['pending','requires_action'].includes(event.status) && event.providerVerified!==true)return true;
   if(!webhookOutcome(value.row,event,now))return false;
   await persist(client,value.row,value.record,now,event.eventId);
   if(value.row.state==='confirmed'){
    const audit=(await client.query('SELECT * FROM er_customer_trip_events WHERE id=$1 AND booking_id=$2',[value.row.trip_event_id,value.row.booking_id])).rows[0];if(!audit)throw conflict();
    for(const kind of ['customer_refund_confirmed','admin_refund_confirmed'])await enqueueBookingEmail(client,value.record,kind,{...audit,created_at:new Date(now)});
   }
   return true;
  })
 };
}
module.exports={refundStorage,prepareRefund,validSource,sameSource,createRefund,submission,outcome,validWebhook,webhookOutcome,applyRefundRecord};
