const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {bookingMessage,createBookingEmails}=require('../services/booking-emails');
const contact={email:'ops@example.test',phone:'(973) 847-4128'};
const record=()=>({id:crypto.randomUUID(),status:'confirmed',paymentStatus:'paid',customer:{firstName:'Test',lastName:'Customer',email:'person@example.test',phone:'2025550101'},trip:{pickup:'Terminal A, Terminal A, 3 Brewster Rd, Newark, NJ',dropoff:'Manhattan',date:'2026-12-30',time:'20:00',vehicle:'suv',passengers:3},quote:{total:150,currency:'usd'}});
const event=(r,kind='pickup_time_changed')=>({id:crypto.randomUUID(),booking_id:r.id,kind,old_start_at:new Date('2026-11-10T17:00:00Z'),new_start_at:new Date(kind==='pickup_time_changed'?'2026-11-11T19:30:00Z':'2026-11-10T17:00:00Z'),details:{oldDate:'2026-11-10',oldTime:'12:00',newDate:'2026-11-11',newTime:'14:30'},created_at:new Date('2026-10-01T16:00:00Z')});

test('pickup-time notifications use immutable old/new audit snapshots and concise customer subject',()=>{
 const r=record(),e=event(r),before=JSON.stringify(r),customer=bookingMessage(r,'customer_pickup_time_updated',contact,null,e),admin=bookingMessage(r,'admin_pickup_time_updated',contact,null,e);
 assert.equal(customer.subject,'Pickup Time Updated | ER Limousine Service');assert.equal(customer.to,r.customer.email);
 assert.ok(customer.text.includes('Reservation ID: '+r.id));assert.match(customer.text,/Old pickup date\/time: 2026-11-10 12:00 \(New York time\)/);assert.match(customer.text,/New pickup date\/time: 2026-11-11 14:30 \(New York time\)/);
 assert.doesNotMatch(customer.text+customer.html,/2026-12-30|20:00/);assert.match(customer.text,/Pickup: Terminal A, 3 Brewster/);assert.match(customer.text,/Destination: Manhattan/);
 assert.equal(admin.subject,'Pickup Time Updated — '+r.id);assert.equal(admin.to,contact.email);assert.match(admin.text,/Customer name: Test Customer/);assert.match(admin.text,/Customer email: person@example\.test/);assert.match(admin.text,/Customer phone: 2025550101/);assert.match(admin.text,/Old pickup date\/time: 2026-11-10 12:00/);assert.match(admin.text,/New pickup date\/time: 2026-11-11 14:30/);
 assert.ok(customer.html.includes('href="tel:+19738474128" style="color:#008000;text-decoration:underline;"'));assert.ok(customer.html.includes('href="mailto:ops%40example.test"'));
 assert.equal(JSON.stringify(r),before);
});

test('cancelled unpaid and late-paid trip emails are accurate and never claim a refund',()=>{
 const r=record();r.status='cancelled';r.paymentStatus='unpaid';const e=event(r,'customer_cancelled'),before=JSON.stringify(r);
 for(const kind of ['customer_trip_cancelled','admin_trip_cancelled']){
  const m=bookingMessage(r,kind,contact,null,e);assert.equal(m.subject,kind.startsWith('admin_')?'Trip Cancelled — '+r.id:'Trip Cancelled | ER Limousine Service');assert.match(m.text,/Reservation status: Cancelled/);assert.match(m.text,/Payment status: Unpaid/);assert.match(m.text,/Pickup date\/time: 2026-11-10 12:00/);assert.doesNotMatch(m.text,/2026-12-30|Complete Payment|Payment is still required|refund processing|refund confirmed/i);
 }
 const customer=bookingMessage(r,'customer_trip_cancelled',contact,null,e);assert.match(customer.text,/No payment is required for this cancelled reservation/);assert.equal(JSON.stringify(r),before);
 r.paymentStatus='paid';r.paymentReviewRequired=true;
 for(const kind of ['customer_trip_cancelled','admin_trip_cancelled']){
  const m=bookingMessage(r,kind,contact,null,e);assert.match(m.text,/Payment was received for this cancelled reservation/);assert.match(m.text,/contact ER Limousine Service for payment review/);assert.match(m.text,/No refund has been confirmed/);assert.match(m.text,/Payment status: Paid/);assert.doesNotMatch(m.text,/trip (?:is|has been) confirmed|refund completed|refund processing|Complete Payment/i);
 }
});

test('action notifications refuse missing, foreign, wrong-kind and incomplete audit events',()=>{
 const r=record(),e=event(r);
 for(const invalid of [null,{...e,booking_id:crypto.randomUUID()},{...e,id:'forged'},{...e,kind:'customer_cancelled'},{...e,old_start_at:null},{...e,new_start_at:'invalid'},{...e,details:{...e.details,oldTime:'25:00'}},{...e,details:{oldDate:e.details.oldDate,oldTime:e.details.oldTime}}])assert.throws(()=>bookingMessage(r,'customer_pickup_time_updated',contact,null,invalid),/Email unavailable/);
 assert.throws(()=>bookingMessage(r,'customer_trip_cancelled',contact,null,e),/Email unavailable/);
});

test('action email text and HTML use escaped stored data without hidden payment credentials',()=>{
 const r=record(),e=event(r);r.trip.pickup='<script>private</script>';r.trip.dropoff='<img src=x onerror=private>';r.customer.firstName='<b>Test</b>';r.stripeSessionId='cs_private';r.customerAccess={tokenHash:'private-access'};r.checkoutAttempt={parameters:{customer:'cus_private'}};
 const customer=bookingMessage(r,'customer_pickup_time_updated',contact,null,e),admin=bookingMessage(r,'admin_pickup_time_updated',contact,null,e);
 for(const m of [customer,admin]){assert.doesNotMatch(m.html,/<script>|<img|<b>Test/);assert.ok(m.html.includes('&lt;script&gt;'));assert.doesNotMatch(JSON.stringify(m),/cs_private|cus_private|private-access|customerAccess|checkoutAttempt/);}
});

test('worker loads the reservation-bound event once and reuses frozen message and provider idempotency key after failure',async()=>{
 const r=record(),e=event(r),now=Date.parse('2026-10-01T16:00:00Z'),job={id:crypto.randomUUID(),booking_id:r.id,event_id:e.id,kind:'customer_pickup_time_updated',claim_token:crypto.randomUUID(),payload:null};
 let available=true,eventCalls=0,fail=true;const sends=[],finishes=[],failures=[];
 const store={claimBookingEmail:async()=>{if(!available)return null;available=false;return {...job};},reservationOwner:async()=>{throw Error('not needed');},get:async id=>{assert.equal(id,r.id);return r;},tripEvent:async(id,bookingId)=>{eventCalls++;assert.equal(id,e.id);assert.equal(bookingId,r.id);return e;},prepareBookingEmail:async(id,token,payload)=>{assert.equal(id,job.id);assert.equal(token,job.claim_token);job.payload=job.payload||structuredClone(payload);return {...job,lease_until:new Date(now+60000),first_submitted_at:new Date(now)};},finishBookingEmail:async(id,token,success)=>{finishes.push(success);}};
 const service=createBookingEmails({store,contact,siteUrl:'http://localhost:3000',now:()=>now,reportFailure:(...args)=>failures.push(args),provider:{enabled:true,sendBookingEmail:async m=>{sends.push(structuredClone(m));if(fail)throw Error('private-provider-body');}}});
 await service.run();assert.equal(eventCalls,1);assert.deepEqual(finishes,[false]);assert.equal(failures.length,1);assert.deepEqual(failures[0],[]);
 available=true;fail=false;e.details.newDate='2026-12-01';r.trip.date='2026-12-31';await service.run();assert.equal(eventCalls,1);assert.deepEqual(finishes,[false,true]);assert.equal(sends.length,2);assert.deepEqual(sends[1],sends[0]);assert.equal(sends[0].idempotencyKey,'booking-email/'+job.id);assert.match(sends[1].text,/New pickup date\/time: 2026-11-11 14:30/);
});

test('worker fails closed without a matching audit event and never sends an unverifiable notification',async()=>{
 const r=record(),e=event(r),job={id:crypto.randomUUID(),booking_id:r.id,event_id:e.id,kind:'customer_trip_cancelled',claim_token:crypto.randomUUID(),payload:null};let available=true,sent=0,prepared=0;const results=[];
 const service=createBookingEmails({store:{claimBookingEmail:async()=>{if(!available)return null;available=false;return job;},get:async()=>r,tripEvent:async()=>e,prepareBookingEmail:async()=>{prepared++;},finishBookingEmail:async(id,token,success)=>results.push(success)},contact,provider:{enabled:true,sendBookingEmail:async()=>{sent++;}}});
 await service.run();assert.equal(sent,0);assert.equal(prepared,0);assert.deepEqual(results,[false]);
});

test('paid cancellation emails distinguish pending and ambiguous refunds without promising completion',()=>{
 const r=record();r.status='cancelled';const e=event(r,'customer_cancelled');
 for(const refundStatus of ['processing','review_required','failed'])for(const kind of ['customer_trip_cancelled','admin_trip_cancelled']){
  r.refundStatus=refundStatus;const m=bookingMessage(r,kind,contact,null,e);
  assert.match(m.text,/Reservation status: Cancelled/);assert.match(m.text,/Payment status: Paid/);assert.match(m.text,/No refund has been confirmed/);assert.doesNotMatch(m.text,/Payment is still required|Complete Payment|full refund has been confirmed|trip has been confirmed/i);
  if(refundStatus==='processing'){assert.match(m.text,/full refund is processing/);assert.match(m.text,/Refund status: Processing — not yet confirmed/);assert.match(m.text,/You do not need to pay again/);}
  else {assert.match(m.text,/refund requires operator review/);assert.match(m.text,/Refund status: Operator review required — not confirmed/);}
 }
});

test('refund confirmation emails require stored confirmed refund state and reservation-bound cancellation audit',()=>{
 const r=record();r.status='cancelled';r.refundStatus='confirmed';r.refundAttempt={stripeRefundId:'re_private',paymentIntent:'pi_private',idempotencyKey:'refund_private'};const e=event(r,'customer_cancelled');
 for(const kind of ['customer_refund_confirmed','admin_refund_confirmed']){
  const m=bookingMessage(r,kind,contact,null,e);assert.equal(m.subject,kind.startsWith('admin_')?'Refund Confirmed — '+r.id:'Refund Confirmed | ER Limousine Service');assert.equal(m.to,kind.startsWith('admin_')?contact.email:r.customer.email);
  assert.match(m.text,/trip remains cancelled/);assert.match(m.text,/full refund has been confirmed/);assert.match(m.text,/Refund status: Full refund confirmed/);assert.match(m.text,/Your bank may take additional time/);assert.match(m.text,/Reservation ID: /);assert.match(m.text,/Pickup date\/time: 2026-11-10 12:00/);
  assert.doesNotMatch(JSON.stringify(m),/re_private|pi_private|refund_private|Complete Payment|Payment is still required|refund is processing/);
  assert.throws(()=>bookingMessage(r,kind,contact,null,{...e,booking_id:crypto.randomUUID()}),/Email unavailable/);assert.throws(()=>bookingMessage(r,kind,contact,null,event(r)),/Email unavailable/);
  for(const refundStatus of [null,'processing','review_required','failed','succeeded'])assert.throws(()=>bookingMessage({...r,refundStatus},kind,contact,null,e),/Email unavailable/);
  assert.throws(()=>bookingMessage({...r,status:'confirmed'},kind,contact,null,e),/Email unavailable/);assert.throws(()=>bookingMessage({...r,paymentStatus:'unpaid'},kind,contact,null,e),/Email unavailable/);
 }
});

test('refund-confirmed outbox retry freezes one safe message and reuses provider idempotency',async()=>{
 const r=record();r.status='cancelled';r.refundStatus='confirmed';const e=event(r,'customer_cancelled'),now=Date.parse('2026-10-01T16:00:00Z'),job={id:crypto.randomUUID(),booking_id:r.id,event_id:e.id,kind:'customer_refund_confirmed',claim_token:crypto.randomUUID(),payload:null};
 let available=true,fail=true,eventCalls=0;const sends=[],results=[],failures=[];
 const service=createBookingEmails({store:{claimBookingEmail:async()=>{if(!available)return null;available=false;return {...job};},get:async()=>r,tripEvent:async(id,b)=>{eventCalls++;assert.equal(id,e.id);assert.equal(b,r.id);return e;},prepareBookingEmail:async(id,token,payload)=>{assert.equal(id,job.id);assert.equal(token,job.claim_token);job.payload=job.payload||structuredClone(payload);return {...job,lease_until:new Date(now+60000),first_submitted_at:new Date(now)};},finishBookingEmail:async(id,token,success)=>results.push(success)},contact,now:()=>now,reportFailure:(...args)=>failures.push(args),provider:{enabled:true,sendBookingEmail:async m=>{sends.push(structuredClone(m));if(fail)throw Error('private-refund-provider-error');}}});
 await service.run();assert.deepEqual(results,[false]);assert.deepEqual(failures,[[]]);available=true;fail=false;r.trip.pickup='Later edit';e.details.oldDate='2026-12-01';await service.run();
 assert.equal(eventCalls,1);assert.deepEqual(results,[false,true]);assert.equal(sends.length,2);assert.deepEqual(sends[1],sends[0]);assert.equal(sends[1].idempotencyKey,'booking-email/'+job.id);assert.match(sends[1].text,/full refund has been confirmed/);assert.doesNotMatch(JSON.stringify(sends[1]),/private-refund-provider-error|Later edit|2026-12-01/);
});

test('refund-review notifications require owned cancellation audit and safe authoritative review state',()=>{
 const r=record();r.status='cancelled';r.refundStatus='review_required';r.refundFailureReason='private-bank-or-provider-detail';r.stripeRefundId='re_private';const e=event(r,'customer_cancelled');
 for(const refundStatus of ['review_required','failed'])for(const kind of ['customer_refund_review','admin_refund_review']){
  const current={...r,refundStatus},m=bookingMessage(current,kind,contact,null,e);assert.equal(m.subject,kind.startsWith('admin_')?'Refund Review Required — '+r.id:'Refund Review Required | ER Limousine Service');assert.equal(m.to,kind.startsWith('admin_')?contact.email:r.customer.email);
  assert.match(m.text,/trip has been cancelled/);assert.match(m.text,/refund requires operator review/);assert.match(m.text,/Please contact ER Limousine Service/);assert.match(m.text,/No refund has been confirmed/);assert.match(m.text,/Reservation status: Cancelled/);assert.match(m.text,/Refund status: Operator review required — not confirmed/);assert.match(m.text,/Pickup date\/time: 2026-11-10 12:00/);
  assert.doesNotMatch(JSON.stringify(m),/private-bank-or-provider-detail|re_private|full refund has been confirmed|bank may take|Complete Payment|Payment is still required/i);
  assert.throws(()=>bookingMessage(current,kind,contact,null,{...e,booking_id:crypto.randomUUID()}),/Email unavailable/);assert.throws(()=>bookingMessage(current,kind,contact,null,event(r)),/Email unavailable/);
  for(const invalidStatus of [null,'processing','confirmed','private-provider-state'])assert.throws(()=>bookingMessage({...r,refundStatus:invalidStatus},kind,contact,null,e),/Email unavailable/);
  assert.throws(()=>bookingMessage({...current,status:'confirmed'},kind,contact,null,e),/Email unavailable/);assert.throws(()=>bookingMessage({...current,paymentStatus:'unpaid'},kind,contact,null,e),/Email unavailable/);
 }
});

test('refund-review email failure retries one frozen correction without provider details or refund submission',async()=>{
 const r=record();r.status='cancelled';r.refundStatus='review_required';const e=event(r,'customer_cancelled'),now=Date.parse('2026-10-01T16:00:00Z'),job={id:crypto.randomUUID(),booking_id:r.id,event_id:e.id,kind:'customer_refund_review',claim_token:crypto.randomUUID(),payload:null};
 let available=true,fail=true,eventCalls=0;const sends=[],results=[],failures=[];
 const service=createBookingEmails({store:{claimBookingEmail:async()=>{if(!available)return null;available=false;return {...job};},get:async()=>r,tripEvent:async(id,b)=>{eventCalls++;assert.equal(id,e.id);assert.equal(b,r.id);return e;},prepareBookingEmail:async(id,token,payload)=>{assert.equal(id,job.id);assert.equal(token,job.claim_token);job.payload=job.payload||structuredClone(payload);return {...job,lease_until:new Date(now+60000),first_submitted_at:new Date(now)};},finishBookingEmail:async(id,token,success)=>results.push(success)},contact,now:()=>now,reportFailure:(...args)=>failures.push(args),provider:{enabled:true,sendBookingEmail:async m=>{sends.push(structuredClone(m));if(fail)throw Error('private-refund-review-provider-error');}}});
 await service.run();assert.deepEqual(results,[false]);assert.deepEqual(failures,[[]]);available=true;fail=false;r.customer.firstName='Later edit';e.details.oldDate='2026-12-01';await service.run();
 assert.equal(eventCalls,1);assert.deepEqual(results,[false,true]);assert.equal(sends.length,2);assert.deepEqual(sends[1],sends[0]);assert.equal(sends[1].idempotencyKey,'booking-email/'+job.id);assert.match(sends[1].subject,/Refund Review Required/);assert.match(sends[1].text,/refund requires operator review/);assert.doesNotMatch(JSON.stringify(sends[1]),/private-refund-review-provider-error|Later edit|2026-12-01|full refund has been confirmed/);
});
