const DAY=24*60*60*1000;
const timestamp=value=>value===null || value===undefined?NaN:new Date(value).getTime();
const iso=value=>Number.isFinite(timestamp(value))?new Date(value).toISOString():null;
const managementError=(status=409)=>Object.assign(new Error('Trip update unavailable. Please refresh and try again.'),{status});
// A browser or an unsigned provider return never decides these capabilities.
function paymentActionPending(record){
 if(record.paymentStatus!=='paid' && record.checkoutAttempt?.state==='session_identified' &&
  ['verified_paid_awaiting_webhook','payment_pending'].includes(record.checkoutAttempt.evidence))return true;
 const a=record.checkoutAttempt;
 if(!a)return false;
 if(a.state==='confirmed_unpaid')return false;
 return ['submitted_unknown','review_required'].includes(a.state) ||
  (!record.stripeSessionId && (a.firstSubmittedAt!==null && a.firstSubmittedAt!==undefined || Number(a.submissionCount)>0));
}
function managementDto(record,startAt,endAt,now){
 const start=timestamp(startAt),end=timestamp(endAt),at=timestamp(now);
 const scheduleValid=Number.isFinite(start) && Number.isFinite(end) && end>=start;
 const active=scheduleValid && Number.isFinite(at) && end>at && !['completed','cancelled'].includes(record.status);
 let cancelReason=null;
 if(!active)cancelReason='inactive';
 else if(start-at<DAY)cancelReason='within_24_hours';
 else if(record.paymentStatus!=='paid' && paymentActionPending(record))cancelReason='payment_processing';
 return {pickupAt:Number.isFinite(start)?new Date(start).toISOString():null,
  serverNow:new Date(at).toISOString(),canChangePickupTime:active,canCancel:active && cancelReason===null,cancelReason};
}
function newYorkFields(value){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
 const get=k=>parts.find(p=>p.type===k)?.value;
 return {date:get('year')+'-'+get('month')+'-'+get('day'),time:get('hour')+':'+get('minute')};
}
// Shared mutation rules for database and isolated test storage. Ownership, session,
// action lock and request replay checks must already have succeeded at the caller.
function applyTripManagement(record,startAt,endAt,input,now,proof=null){
 const capabilities=managementDto(record,startAt,endAt,now);
 if(iso(startAt)!==input.expectedPickupAt)throw managementError();
 let nextStart=iso(startAt),nextEnd=iso(endAt);
 const details={expectedPickupAt:input.expectedPickupAt,oldDate:record.trip.date,oldTime:record.trip.time};
 if(input.kind==='pickup_time_changed'){
  if(!capabilities.canChangePickupTime || !Number.isFinite(timestamp(input.startAt)) || !Number.isFinite(timestamp(input.endAt)) || timestamp(input.startAt)<=timestamp(now))throw managementError();
  const fields=newYorkFields(input.startAt);
  if(fields.date!==input.date || fields.time!==input.time)throw managementError(400);
  const expectedEnd=record.trip.tripType==='roundtrip'?timestamp(endAt):timestamp(input.startAt)+(record.trip.tripType==='hourly'?Number(record.trip.hours)*3600000:0);
  if(!Number.isFinite(expectedEnd) || expectedEnd<timestamp(input.startAt) || record.trip.tripType==='roundtrip' && expectedEnd<=timestamp(input.startAt) || timestamp(input.endAt)!==expectedEnd)throw managementError();
  if(timestamp(input.startAt)===timestamp(startAt) && timestamp(input.endAt)===timestamp(endAt) && record.trip.date===input.date && record.trip.time===input.time)return {changed:false};
  if(record.paymentStatus!=='paid'){
   if(paymentActionPending(record) || proof?.safe!==true || (proof.sessionId || null)!==(record.stripeSessionId || null))throw managementError();
   if(proof.invalidateCheckout===true){
    details.checkoutInvalidated=true;details.expiredCheckoutSessionId=record.stripeSessionId || null;details.retiredCheckoutAttemptKey=record.checkoutAttempt?.key || null;
    record.stripeSessionId=null;record.checkoutAttempt=null;
   }
  }else if(proof?.invalidateCheckout===true)throw managementError();
  nextStart=iso(input.startAt);nextEnd=iso(input.endAt);
  record.trip.date=input.date;record.trip.time=input.time;
  details.newDate=input.date;details.newTime=input.time;
 }else if(input.kind==='customer_cancelled'){
  // The proof is internal and must describe the exact session read under the lock.
  if(!capabilities.canCancel || record.paymentStatus!=='paid' && paymentActionPending(record) || proof?.safe!==true || (proof.sessionId || null)!==(record.stripeSessionId || null) || record.paymentStatus==='paid' && !proof.refundSource)throw managementError();
  record.status='cancelled';record.cancellationReason='customer_cancelled';
  if(record.checkoutAttempt && record.paymentStatus!=='paid'){record.checkoutAttempt.state='confirmed_unpaid';record.checkoutAttempt.evidence='verified_cancelled_unpaid';record.checkoutAttempt.lastReconciledAt=timestamp(now);}
 }else throw managementError(400);
 return {changed:true,startAt:nextStart,endAt:nextEnd,details};
}
module.exports={managementDto,paymentActionPending,applyTripManagement,DAY};
