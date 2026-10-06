const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{createRequire}=require('node:module'),{Pool}=require('pg');
const file=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(file,'utf8');
const {harness,booking}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(file),__dirname);
const origin={origin:'http://localhost:3000','sec-fetch-site':'same-origin'},account={fullName:'Refund Owner',email:'refund-owner@example.test',phone:'2025550174',password:'Synthetic refund owner password'};
const cookie=r=>r.headers.getSetCookie().find(x=>x.includes('er_customer_session'))?.split(';')[0];
const register=(h,extra={})=>h.request('/api/customer/register',{...account,...extra});
const detail=(h,id,c)=>h.request('/api/customer/trips/'+id,undefined,{cookie:c});
const pay=(h,id,c)=>h.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c});
const action=(h,id,c,kind,body)=>h.request('/api/customer/trips/'+id+'/'+kind,body,{...origin,cookie:c});
const cancelBody=trip=>({expectedPickupAt:trip.management.pickupAt,requestId:crypto.randomUUID(),confirmed:true});
const timeBody=(trip,date='2026-11-11',time='13:30')=>({...cancelBody(trip),date,time});
async function setup(t,{paid=true,trip={},env={},store}={}){
 const h=await harness(t,env,'[]',store),c=cookie(await register(h)),r=await h.request('/api/checkout',{...booking,paymentChoice:'later',...trip},{cookie:c});assert.equal(r.status,200);
 const id=r.body.bookingId;let session=null;
 if(paid){assert.equal((await pay(h,id,c)).status,200);session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session)).status,200);}
 return {h,c,id,session,trip:(await detail(h,id,c)).body.trip};
}
const record=(h,id)=>h.testStore.get(id);
const refund=h=>[...h.state.refunds.values()][0];
const waitForRefund=async h=>{const until=Date.now()+5000;while(!h.state.refundRequests.length && Date.now()<until)await new Promise(r=>setTimeout(r,2));assert.ok(h.state.refundRequests.length,'expected bounded refund request to start');};
const refundWebhook=async(h,r,type='refund.updated',invalid=false,eventId='evt_refund_'+crypto.randomUUID().replace(/-/g,''),updateProvider=true)=>{
 if(updateProvider && !invalid && h.state.refunds.has(r.id) && ['pending','requires_action','succeeded','failed','canceled'].includes(r.status))h.state.refunds.get(r.id).status=r.status;
 const payload=JSON.stringify({id:eventId,type,data:{object:r}}),signature=h.signatureSdk.webhooks.generateTestHeaderString({payload,secret:'whsec_local_mock'});
 return h.request('/api/stripe-webhook',invalid?payload+' ':payload,{'stripe-signature':signature});
};

test('paid cancellation at and beyond 24h uses captured stored fare, waits for signed refund webhook and never charges again',async t=>{
 for(const time of ['12:00','12:01']){
  const {h,c,id,trip}=await setup(t,{trip:{date:'2026-10-02',time,promoCode:'FIRST15'}}),before=await record(h,id),body=cancelBody(trip);
  assert.equal(before.quote.total,85);assert.equal(trip.management.canCancel,true);
  const out=await action(h,id,c,'cancel',body);assert.equal(out.status,200);const cancelled=await record(h,id);
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.paymentStatus,'paid');assert.equal(cancelled.refundStatus,'processing');assert.deepEqual(cancelled.quote,before.quote);
  assert.equal(h.state.refundRequests.length,1);assert.equal(h.state.refundRequests[0].params.amount,8500);assert.ok(h.state.refundRequests[0].options.idempotencyKey);assert.equal(refund(h).amount,8500);
  assert.equal((await pay(h,id,c)).status,409);assert.equal(h.state.creates.length,1);
  assert.equal((await action(h,id,c,'cancel',body)).status,200);assert.equal((await action(h,id,c,'cancel',cancelBody(trip))).status,200);assert.equal(h.state.refundRequests.length,1);
  assert.equal((await refundWebhook(h,refund(h),'refund.updated',true)).status,400);assert.equal((await record(h,id)).refundStatus,'processing');
  const eventId='evt_refund_'+crypto.randomUUID().replace(/-/g,'');assert.equal((await refundWebhook(h,refund(h),'refund.updated',false,eventId)).status,200);assert.equal((await record(h,id)).refundStatus,'confirmed');assert.equal((await record(h,id)).status,'cancelled');assert.equal((await record(h,id)).paymentStatus,'paid');
  assert.equal((await refundWebhook(h,refund(h),'refund.updated',false,eventId)).status,200);assert.equal(h.state.refunds.size,1);assert.equal((await pay(h,id,c)).status,409);
 }
});

test('paid cancellation inside 24h, foreign account, guest, forged amounts and unverified captured payment fail closed',async t=>{
 const near=await setup(t,{trip:{date:'2026-10-02',time:'11:59'}});assert.equal(near.trip.management.canCancel,false);assert.equal((await action(near.h,near.id,near.c,'cancel',cancelBody(near.trip))).status,409);assert.equal(near.h.state.refundRequests.length,0);assert.equal((await record(near.h,near.id)).status,'confirmed');
 const {h,c,id,trip}=await setup(t),other=cookie(await register(h,{email:'refund-foreign@example.test',phone:'2035550174'})),body=cancelBody(trip);
 assert.equal((await action(h,id,other,'cancel',body)).status,404);assert.equal((await action(h,id,'','cancel',body)).status,401);
 for(const extra of [{amount:1},{refundAmount:1},{payment_intent:'pi_foreign'},{customer_id:crypto.randomUUID()}])assert.equal((await action(h,id,c,'cancel',{...body,...extra})).status,400);
 assert.equal(h.state.refundRequests.length,0);
 h.state.chargeOverride={amount_captured:1};assert.equal((await action(h,id,c,'cancel',body)).status,503);assert.equal(h.state.refundRequests.length,0);assert.equal((await record(h,id)).status,'confirmed');
});

test('mismatched or already-refunded capture evidence cannot authorize a new refund',async t=>{
 for(const patch of [{amount:1},{currency:'eur'},{payment_intent:'pi_foreign'},{captured:false},{paid:false},{disputed:true},{amount_refunded:10000}]){
  const {h,c,id,trip}=await setup(t);h.state.chargeOverride=patch;
  const result=await action(h,id,c,'cancel',cancelBody(trip));assert.equal(result.status,503);assert.equal(h.state.paymentIntentRequests.length,1);assert.equal(h.state.chargeRequests.length,1);assert.equal(h.state.refundRequests.length,0);assert.equal((await record(h,id)).status,'confirmed');assert.equal((await record(h,id)).paymentStatus,'paid');
 }
 for(const patch of [{status:'processing'},{amount_received:1},{currency:'eur'},{latest_charge:null}]){
  const {h,c,id,trip}=await setup(t);h.state.paymentIntentOverride=patch;const result=await action(h,id,c,'cancel',cancelBody(trip));assert.equal(result.status,503);assert.equal(h.state.paymentIntentRequests.length,1);assert.equal(h.state.refundRequests.length,0);assert.equal((await record(h,id)).status,'confirmed');
 }
});

test('pending/failed/mismatched refund objects cannot claim completed refund; only exact signed succeeded association confirms',async t=>{
 const {h,c,id,trip}=await setup(t);h.state.refundStatus='pending';assert.equal((await action(h,id,c,'cancel',cancelBody(trip))).status,200);
 assert.equal((await record(h,id)).refundStatus,'processing');const r=refund(h);
 assert.equal((await refundWebhook(h,r,'refund.created')).status,200);assert.equal((await record(h,id)).refundStatus,'processing');
 for(const patch of [{amount:1},{currency:'eur'},{payment_intent:'pi_foreign'},{charge:'ch_foreign'},{metadata:{...r.metadata,bookingId:crypto.randomUUID()}},{metadata:{...r.metadata,applicationRefundId:crypto.randomUUID()}}]){
  const result=await refundWebhook(h,{...r,...patch,status:'succeeded'},'refund.updated');assert.ok([200,400,409].includes(result.status));assert.notEqual((await record(h,id)).refundStatus,'confirmed');
 }
 assert.equal((await refundWebhook(h,{...r,status:'failed'},'refund.failed')).status,200);assert.equal((await record(h,id)).refundStatus,'review_required');assert.equal((await record(h,id)).status,'cancelled');assert.equal(h.state.refundRequests.length,1);
});

test('lost refund response and later provider error preserve durable submission identity across retry/restart',async t=>{
 const {h,c,id,trip}=await setup(t);h.state.loseRefundResponse=true;const body=cancelBody(trip),first=await action(h,id,c,'cancel',body);
 assert.ok([200,503].includes(first.status));assert.equal((await record(h,id)).status,'cancelled');assert.notEqual((await record(h,id)).refundStatus,'confirmed');assert.equal(h.state.refunds.size,1);
 const key=h.state.refundRequests[0].options.idempotencyKey,params=structuredClone(h.state.refundRequests[0].params);
 h.state.refundError=Object.assign(new Error('synthetic private later refund error'),{type:'StripeInvalidRequestError',code:'parameter_invalid_integer'});
 const retry=await action(h,id,c,'cancel',body);assert.ok([200,503].includes(retry.status));assert.notEqual((await record(h,id)).refundStatus,'confirmed');assert.equal(h.state.refunds.size,1);
 for(const r of h.state.refundRequests){assert.equal(r.options.idempotencyKey,key);assert.deepEqual(r.params,params);}
 const restarted=await harness(t,{},'[]',h.testStore);restarted.state.sessions=h.state.sessions;restarted.state.refunds=h.state.refunds;
 assert.equal((await action(restarted,id,c,'cancel',body)).status,200);assert.equal(restarted.state.refunds.size,1);for(const r of restarted.state.refundRequests){assert.equal(r.options.idempotencyKey,key);assert.deepEqual(r.params,params);}
 assert.notEqual((await record(restarted,id)).refundStatus,'confirmed');assert.equal((await refundWebhook(restarted,refund(restarted),'refund.updated')).status,200);assert.equal((await record(restarted,id)).refundStatus,'confirmed');
 assert.ok(!h.state.logs.join('').includes('synthetic private later refund error'));
});

test('signed pending refund after lost response identifies the existing refund without a second provider POST',async t=>{
 const {h,c,id,trip}=await setup(t);h.state.refundStatus='pending';h.state.loseRefundResponse=true;const body=cancelBody(trip);assert.equal((await action(h,id,c,'cancel',body)).status,200);assert.equal(h.state.refundRequests.length,1);
 const r=refund(h);assert.equal((await refundWebhook(h,r,'refund.created')).status,200);assert.equal((await record(h,id)).refundStatus,'processing');assert.equal((await h.testStore.refundForBooking(id)).stripe_refund_id,r.id);
 const retrievals=h.state.refundRetrievals.length;assert.equal((await action(h,id,c,'cancel',body)).status,200);assert.equal(h.state.refundRequests.length,1);assert.equal(h.state.refundRetrievals.length,retrievals+1);
 r.status='succeeded';assert.equal((await action(h,id,c,'cancel',body)).status,200);assert.equal(h.state.refundRequests.length,1);assert.equal((await record(h,id)).refundStatus,'processing');
 assert.equal((await refundWebhook(h,r)).status,200);assert.equal((await record(h,id)).refundStatus,'confirmed');assert.equal(h.state.refunds.size,1);
});

test('concurrent paid Cancel and email failure cannot duplicate refunds or undo cancellation/payment state',async t=>{
 const {h,c,id,trip}=await setup(t,{env:{BOOKING_EMAILS_ENABLED:'true',COMPANY_EMAIL:'ops@example.test'}});h.state.refundDelay=70;h.state.emailFail=true;const body=cancelBody(trip);
 const first=action(h,id,c,'cancel',body);await waitForRefund(h);const second=await action(h,id,c,'cancel',body);assert.equal(second.status,409);assert.equal((await first).status,200);assert.equal(h.state.refunds.size,1);
 await h.context.runBookingEmails();assert.equal((await record(h,id)).status,'cancelled');assert.equal((await record(h,id)).paymentStatus,'paid');assert.equal((await record(h,id)).refundStatus,'processing');
 const eventId='evt_refund_'+crypto.randomUUID().replace(/-/g,'');await refundWebhook(h,refund(h),'refund.updated',false,eventId);await refundWebhook(h,refund(h),'refund.updated',false,eventId);h.state.emailFail=false;h.advance(60000);await h.context.runBookingEmails();await h.context.runBookingEmails();
 assert.equal(h.state.refundRequests.length,1);assert.equal((await record(h,id)).refundStatus,'confirmed');
 const jobs=[...h.testStore.shared.bookingEmails.values()];assert.equal(new Set(jobs.map(j=>j.id)).size,jobs.length);assert.equal(jobs.filter(j=>j.kind==='customer_trip_cancelled').length,1);assert.equal(jobs.filter(j=>j.kind==='admin_trip_cancelled').length,1);
 assert.ok(!h.state.logs.join('').includes(account.email));
});

test('unresolved refund beyond safe provider idempotency window becomes operator review without a new submission',async t=>{
 const {h,c,id,trip}=await setup(t);h.state.loseRefundResponse=true;const body=cancelBody(trip);const first=await action(h,id,c,'cancel',body);assert.ok([200,503].includes(first.status));assert.equal(h.state.refunds.size,1);
 const key=h.state.refundRequests[0].options.idempotencyKey;h.advance(23*3600000);assert.equal((await action(h,id,c,'cancel',body)).status,200);
 const after=await record(h,id);assert.equal(after.status,'cancelled');assert.equal(after.paymentStatus,'paid');assert.equal(after.refundStatus,'review_required');assert.equal(after.paymentReviewRequired,true);assert.equal(h.state.refundRequests.length,1);assert.equal(h.state.refundRequests[0].options.idempotencyKey,key);assert.equal(h.state.refunds.size,1);
});

test('a verified later refund failure supersedes confirmation, while stale failure cannot override current Stripe success',async t=>{
 const {h,c,id,trip}=await setup(t);assert.equal((await action(h,id,c,'cancel',cancelBody(trip))).status,200);const r=refund(h);
 assert.equal((await refundWebhook(h,r)).status,200);let before=await record(h,id);assert.equal(before.refundStatus,'confirmed');assert.ok(before.refundConfirmedAt);
 const confirmedAt=before.refundConfirmedAt,eventsBefore=h.testStore.shared.refundEvents.size;
 const eventId='evt_refund_'+crypto.randomUUID().replace(/-/g,'');assert.equal((await refundWebhook(h,{...r,status:'failed'},'refund.failed',false,eventId,false)).status,200);let after=await record(h,id);assert.equal(after.refundStatus,'confirmed');assert.equal(after.refundConfirmedAt,confirmedAt);assert.equal(h.state.refundRequests.length,1);
 assert.equal((await refundWebhook(h,{...r,status:'failed'},'refund.failed')).status,200);after=await record(h,id);assert.equal(after.status,'cancelled');assert.equal(after.paymentStatus,'paid');assert.equal(after.refundStatus,'review_required');assert.equal(after.paymentReviewRequired,true);assert.equal(after.refundConfirmedAt,undefined);assert.equal((await h.testStore.refundForBooking(id)).confirmed_at,confirmedAt);assert.ok(h.testStore.shared.refundEvents.size>eventsBefore);assert.equal(h.state.refundRequests.length,1);
 const second=await setup(t);assert.equal((await action(second.h,second.id,second.c,'cancel',cancelBody(second.trip))).status,200);const secondRefund=refund(second.h);await refundWebhook(second.h,secondRefund);const secondConfirmedAt=(await record(second.h,second.id)).refundConfirmedAt;
 assert.equal((await refundWebhook(second.h,{...secondRefund,status:'requires_action'})).status,200);after=await record(second.h,second.id);assert.ok(['processing','review_required'].includes(after.refundStatus));assert.equal(after.status,'cancelled');assert.equal(after.paymentStatus,'paid');assert.equal(after.refundConfirmedAt,undefined);assert.equal((await second.h.testStore.refundForBooking(second.id)).confirmed_at,secondConfirmedAt);assert.equal(second.h.state.refundRequests.length,1);
});

test('unpaid pickup change expires open Checkout without replacing it; next payment uses new time and unchanged stored fare',async t=>{
 const {h,c,id,trip}=await setup(t,{paid:false});await pay(h,id,c);const old=[...h.state.sessions.values()][0],before=await record(h,id),body=timeBody(trip);
 const out=await action(h,id,c,'pickup-time',body);assert.equal(out.status,200);assert.equal(old.status,'expired');assert.equal(h.state.creates.length,1);assert.equal(h.state.sessions.size,1);
 let after=await record(h,id);assert.equal(after.id,id);assert.equal(after.paymentStatus,'unpaid');assert.deepEqual(after.quote,before.quote);assert.equal(after.trip.date,body.date);assert.equal(after.trip.time,body.time);
 assert.equal((await action(h,id,c,'pickup-time',body)).status,200);assert.equal(h.state.creates.length,1);
 const payment=await pay(h,id,c);assert.equal(payment.status,200);assert.equal(h.state.sessions.size,2);assert.equal(h.state.creates.length,2);const latest=h.state.creates.at(-1);
 assert.notEqual(latest.options.idempotencyKey,h.state.creates[0].options.idempotencyKey);assert.equal(latest.params.line_items[0].price_data.unit_amount,10000);assert.match(latest.params.line_items[0].price_data.product_data.description,/2026-11-11.*13:30/);
 assert.equal((await pay(h,id,c)).status,200);assert.equal(h.state.creates.length,2);after=await record(h,id);assert.deepEqual(after.quote,before.quote);
});

test('in-progress/ambiguous Checkout prevents schedule mutation; paid schedule edit performs no Checkout/refund work',async t=>{
 for(const mode of ['pending','unknown','retrieve_error','lost_expiry']){
  const {h,c,id,trip}=await setup(t,{paid:false});if(mode==='unknown')h.state.loseResponse=true;await pay(h,id,c);const s=[...h.state.sessions.values()][0],before=await record(h,id);
  if(mode==='pending'){s.status='complete';s.payment_status='paid';}if(mode==='retrieve_error')h.state.retrieveError=true;
  if(mode==='lost_expiry')vm.runInContext('const originalExpiryForTest=stripe.checkout.sessions.expire;stripe.checkout.sessions.expire=async(...args)=>{await originalExpiryForTest(...args);throw new Error("synthetic private expiry response lost");};',h.context);
  const out=await action(h,id,c,'pickup-time',timeBody(trip));assert.ok([409,503].includes(out.status));const after=await record(h,id);assert.deepEqual(after.trip,before.trip);assert.deepEqual(after.quote,before.quote);assert.equal(h.state.creates.length,1);assert.equal(h.state.refundRequests.length,0);assert.equal(h.testStore.shared.tripEvents.size,0);
  if(mode==='lost_expiry'){
   assert.equal(s.status,'expired');const retry=await action(h,id,c,'pickup-time',timeBody(trip));assert.equal(retry.status,200);assert.equal((await record(h,id)).trip.date,'2026-11-11');assert.equal(h.state.creates.length,1);assert.equal(h.testStore.shared.tripEvents.size,1);
  }
 }
 const {h,c,id,trip}=await setup(t),before=await record(h,id),counts=[h.state.creates.length,h.state.paymentIntentRequests.length,h.state.refundRequests.length];h.state.retrieveError=true;
 assert.equal((await action(h,id,c,'pickup-time',timeBody(trip))).status,200);const after=await record(h,id);assert.equal(after.paymentStatus,'paid');assert.deepEqual(after.quote,before.quote);assert.deepEqual([h.state.creates.length,h.state.paymentIntentRequests.length,h.state.refundRequests.length],counts);
});

test('signed payment arriving during Checkout expiry blocks stale unpaid invalidation and preserves payment association',async t=>{
 const {h,c,id,trip}=await setup(t,{paid:false});await pay(h,id,c);const s=[...h.state.sessions.values()][0],before=await record(h,id);
 h.context.onPickupExpiry=async()=>{s.status='complete';s.payment_status='paid';assert.equal((await h.webhook(s)).status,200);};
 vm.runInContext('const expiryBeforePaidTest=stripe.checkout.sessions.expire;stripe.checkout.sessions.expire=async(...args)=>{const result=await expiryBeforePaidTest(...args),snapshot={...result};await onPickupExpiry();return snapshot;};',h.context);
 assert.equal((await action(h,id,c,'pickup-time',timeBody(trip))).status,409);
 const paid=await record(h,id);assert.equal(paid.paymentStatus,'paid');assert.equal(paid.stripeSessionId,s.id);assert.deepEqual(paid.trip,before.trip);assert.deepEqual(paid.quote,before.quote);assert.equal(h.testStore.shared.tripEvents.size,0);assert.equal(h.state.creates.length,1);
 const retry=await action(h,id,c,'pickup-time',timeBody(trip));assert.equal(retry.status,200);const updated=await record(h,id);assert.equal(updated.paymentStatus,'paid');assert.equal(updated.stripeSessionId,s.id);assert.equal(updated.trip.date,'2026-11-11');assert.equal(h.state.creates.length,1);assert.equal(h.state.refundRequests.length,0);
});

test('PostgreSQL refund attempt is durable and cross-worker cancellation prevents duplicate provider refunds',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const u=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:u.toString()}),schema='refunds_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:u.toString(),options:'-c search_path='+schema}),otherPool=new Pool({connectionString:u.toString(),options:'-c search_path='+schema}),{createStore}=require('../storage/postgres'),store=createStore({},pool),other=createStore({},otherPool);
 t.after(async()=>{await store.close();await other.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await Promise.all([store.migrate(),other.migrate()]);
 const {h,c,id,trip}=await setup(t,{store}),worker=await harness(t,{},'[]',other);worker.state.sessions=h.state.sessions;worker.state.refunds=h.state.refunds;
 h.state.refundDelay=70;h.state.loseRefundResponse=true;const body=cancelBody(trip),first=action(h,id,c,'cancel',body);await waitForRefund(h);assert.equal((await action(worker,id,c,'cancel',body)).status,409);assert.ok([200,503].includes((await first).status));
 assert.equal((await store.get(id)).status,'cancelled');assert.equal(h.state.refunds.size,1);const key=h.state.refundRequests[0].options.idempotencyKey;
 assert.equal((await action(worker,id,c,'cancel',body)).status,200);for(const request of worker.state.refundRequests)assert.equal(request.options.idempotencyKey,key);assert.equal(worker.state.refunds.size,1);assert.equal((await store.get(id)).refundStatus,'processing');
 await store.migrate();const eventId='evt_refund_'+crypto.randomUUID().replace(/-/g,'');assert.equal((await refundWebhook(worker,refund(worker),'refund.updated',false,eventId)).status,200);assert.equal((await store.get(id)).refundStatus,'confirmed');assert.equal((await refundWebhook(worker,refund(worker),'refund.updated',false,eventId)).status,200);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM er_customer_trip_events WHERE booking_id=$1 AND kind='customer_cancelled'",[id])).rows[0].n,1);assert.equal((await pool.query("SELECT count(*)::int AS n FROM er_booking_email_outbox WHERE booking_id=$1 AND kind IN ('customer_trip_cancelled','admin_trip_cancelled')",[id])).rows[0].n,2);
 assert.equal((await pay(worker,id,c)).status,409);assert.equal((await store.get(id)).paymentStatus,'paid');
});
