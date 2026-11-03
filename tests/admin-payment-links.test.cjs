'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module'),crypto=require('node:crypto'),{Pool}=require('pg');
const anchor=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(anchor,'utf8'),{harness,booking}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(anchor),__dirname);
const env={BOOKING_EMAILS_ENABLED:'true',COMPANY_EMAIL:'ops@example.test',COMPANY_PHONE:'2025550100'};
const cookie=r=>r.headers.getSetCookie()[0].split(';')[0],login=async h=>cookie(await h.request('/api/admin/login',{token:'local-test-token'}));
function hosted(h){vm.runInContext("const adminLinkOriginalCreate=stripe.checkout.sessions.create;stripe.checkout.sessions.create=async(...args)=>{const s=await adminLinkOriginalCreate(...args);s.url='https://checkout.stripe.com/c/pay/'+s.id+'#isolated';return s;};",h.context);return h;}
const create=async(t,extra={},store)=>hosted(await harness(t,{...env,...extra},'[]',store));
const reserve=(h,extra={},auth={})=>h.request('/api/checkout',{...booking,vehicle:'suv',paymentChoice:'later',...extra},auth);
const action=(h,id,c,kind='copy',body=kind==='email'?{confirmed:true}:{},extra={})=>h.request('/api/bookings/'+id+'/payment-link/'+kind,body,{origin:'http://localhost:3000','sec-fetch-site':'same-origin',cookie:c,...extra});
const flush=h=>h.context.runBookingEmails(),links=h=>[...h.testStore.shared.adminPaymentLinks.values()];
const linkCalls=h=>h.state.bookingCalls.filter(c=>c.subject==='Complete Your Reservation Payment | ER Limousine Service');

test('admin Copy uses the existing stored fare without repricing, reservation creation, access cookies or ownership changes',async t=>{
 const h=await create(t),c=await login(h),r=await reserve(h),id=r.body.bookingId,original=structuredClone(h.records()[0]),before=h.state.googleCalls;
 const out=await action(h,id,c);assert.equal(out.status,200);assert.match(out.body.url,/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_mock_/);assert.ok(Date.parse(out.body.expiresAt));assert.equal(out.headers.get('cache-control'),'no-store');assert.equal(out.headers.getSetCookie().length,0);
 assert.equal(h.records().length,1);assert.equal(h.state.creates.length,1);assert.equal(h.state.googleCalls,before);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,8000);assert.equal(h.state.creates[0].params.customer,undefined);assert.equal(h.state.creates[0].params.saved_payment_method_options,undefined);
 assert.equal(await h.testStore.reservationOwner(id),null);assert.deepEqual(h.records()[0].trip,original.trip);assert.deepEqual(h.records()[0].customer,original.customer);assert.deepEqual(h.records()[0].quote,original.quote);assert.deepEqual(h.records()[0].customerAccess,original.customerAccess);assert.equal(h.records()[0].paymentStatus,'unpaid');
 assert.equal(links(h).length,1);assert.ok(links(h)[0].copied_by);assert.equal(links(h)[0].payload,null);
 const denied=await h.request('/api/booking/'+id);assert.equal(denied.status,401);assert.equal((await h.request('/api/customer/profile')).status,401);
 const page=await h.request('/payment-link-result.html?paid=true&booking='+id);assert.equal(page.status,200);assert.match(page.body,/after your payment has been verified/);assert.doesNotMatch(page.body,/<script|checking your reservation|Payment received/i);assert.equal(h.records()[0].paymentStatus,'unpaid');
});
test('only current authorized admins and exact same-origin confirmed inputs can copy/send; guests/customers and forged prices/recipient are denied',async t=>{
 const h=await create(t),c=await login(h),r=await reserve(h),id=r.body.bookingId;
 for(const kind of ['copy','email']){
  assert.equal((await action(h,id,'',kind)).status,401);assert.equal((await action(h,id,'',kind,undefined,{authorization:'Bearer local-test-token'})).status,401);
  for(const extra of [{origin:'https://attacker.example'},{origin:''},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'cross-site'}])assert.equal((await action(h,id,c,kind,undefined,extra)).status,403);
  for(const body of [{amount:1},{total:1},{email:'other@example.test'},{customerId:crypto.randomUUID()},{confirmed:false}])assert.equal((await action(h,id,c,kind,body)).status,403);
 }
 const customer=await h.request('/api/customer/register',{fullName:'Separate Account',email:booking.email,phone:booking.phone,password:'Synthetic account password'});assert.equal((await action(h,id,cookie(customer))).status,401);
 assert.equal((await action(h,'not-a-uuid',c)).status,400);assert.equal((await action(h,crypto.randomUUID(),c)).status,404);assert.equal(h.state.creates.length,0);assert.equal(links(h).length,0);
 await h.request('/api/admin/logout',{},{cookie:c});assert.equal((await action(h,id,c)).status,401);
});
test('duplicate Copy/Send and customer completion share one action lock/Checkout and one email delivery per session',async t=>{
 const h=await create(t),c=await login(h),r=await reserve(h),id=r.body.bookingId;h.state.createDelay=60;
 const results=await Promise.all([action(h,id,c),action(h,id,c)]);assert.ok(results.some(r=>r.status===200));assert.ok(results.every(r=>[200,409].includes(r.status)));assert.equal(h.state.creates.length,1);
 const copied=await action(h,id,c);assert.equal(copied.status,200);assert.equal(h.state.creates.length,1);
 assert.equal((await action(h,id,c,'email')).status,200);await flush(h);assert.equal((await action(h,id,c,'email')).status,200);await flush(h);
 assert.equal(linkCalls(h).length,1);assert.equal(linkCalls(h)[0].to,booking.email);assert.equal(links(h).length,1);assert.equal(links(h)[0].state,'sent');assert.equal(links(h)[0].payload,null);assert.equal(h.records().length,1);
 const guest=r.headers.getSetCookie().filter(x=>x.includes('er_booking_access_')).map(x=>x.split(';')[0]).join('; ');
 const paid=await h.request('/api/booking/'+id+'/checkout',{}, {origin:'http://localhost:3000','sec-fetch-site':'same-origin',cookie:guest});assert.equal(paid.status,200);assert.equal(paid.body.url,copied.body.url);assert.equal(h.state.creates.length,1);
});
test('verified expired/unpaid sessions are replaced; open sessions are reused; provider uncertainty and processing fail closed',async t=>{
 const h=await create(t),c=await login(h),r=await reserve(h),id=r.body.bookingId;await action(h,id,c);const old=[...h.state.sessions.values()][0];
 h.state.retrieveError=true;assert.equal((await action(h,id,c)).status,503);assert.equal(h.state.creates.length,1);h.state.retrieveError=false;
 old.status='expired';old.payment_status='paid';assert.equal((await action(h,id,c)).status,409);assert.equal(h.state.creates.length,1);
 old.payment_status='unpaid';const next=await action(h,id,c);assert.equal(next.status,200);assert.equal(h.state.creates.length,2);assert.notEqual(next.body.url,old.url);assert.equal(h.state.creates[1].params.line_items[0].price_data.unit_amount,8000);assert.equal(links(h).length,2);
 const current=[...h.state.sessions.values()][1];current.status='complete';current.payment_status='paid';assert.equal((await action(h,id,c)).status,409);assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal(h.state.creates.length,2);
});
test('a lost Stripe response retries one persisted idempotency key instead of creating another reservation/session',async t=>{
 const h=await create(t),c=await login(h),r=await reserve(h),id=r.body.bookingId;h.state.loseResponse=true;
 assert.equal((await action(h,id,c)).status,503);assert.equal(h.records()[0].stripeSessionId,null);assert.equal((await action(h,id,c)).status,200);assert.equal(h.state.sessions.size,1);assert.equal(h.records().length,1);assert.equal(h.state.creates[0].options.idempotencyKey,h.state.creates[1].options.idempotencyKey);
});
test('Send queues only the stored recipient; retry freezes the message/key and preserves existing reservation/payment notifications',async t=>{
 const h=await create(t),c=await login(h),r=await reserve(h),id=r.body.bookingId;await flush(h);h.state.emailFail=true;
 const response=await action(h,id,c,'email');assert.equal(response.status,200);assert.ok(!Object.hasOwn(response.body,'url'));await flush(h);assert.equal(links(h)[0].state,'pending');const first=structuredClone(linkCalls(h)[0]);assert.match(first.text,/Total: \$80\.00/);assert.match(first.text,/payment only/);assert.equal(first.to,booking.email);
 h.state.emailFail=false;h.advance(30001);await flush(h);assert.equal(links(h)[0].state,'sent');assert.deepEqual(linkCalls(h)[1],first);
 const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session,'checkout.session.completed',true)).status,400);assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal((await h.webhook(session)).status,200);assert.equal((await h.webhook(session)).status,200);await flush(h);
 assert.equal(h.records()[0].paymentStatus,'paid');assert.equal(h.records()[0].status,'confirmed');for(const kind of ['reservation_created','customer_reservation_created','payment_confirmed','admin_payment_confirmed'])assert.equal([...h.testStore.shared.bookingEmails.values()].filter(j=>j.booking_id===id&&j.kind===kind).length,1);
 const confirmations=h.state.bookingMessages.filter(m=>m.subject.startsWith('Payment Confirmed'));assert.equal(confirmations.length,2);assert.deepEqual(confirmations.map(m=>m.to).sort(),[booking.email,env.COMPANY_EMAIL].sort());
 assert.equal((await action(h,id,c)).status,409);assert.equal(h.state.sessions.size,1);const logs=h.state.logs.join('\n');assert.doesNotMatch(logs,/checkout\.stripe|#isolated|sk_test_|whsec_|local-test-token|test@example/);
});

test('cancelled/paid/review reservations cannot acquire links; cancelling an open link expires Checkout and never creates a refund',async t=>{
 const h=await create(t),c=await login(h),r=await reserve(h),id=r.body.bookingId;await action(h,id,c);const s=[...h.state.sessions.values()][0];
 const cancelled=await h.request('/api/bookings/'+id,{status:'cancelled'},{cookie:c,origin:'http://localhost:3000'},'PATCH');assert.equal(cancelled.status,200);assert.equal(s.status,'expired');assert.equal((await action(h,id,c)).status,409);assert.equal((await action(h,id,c,'email')).status,409);assert.equal(h.state.creates.length,1);assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal(h.records()[0].refundStatus,undefined);
 // A provider completion that raced cancellation is never accepted as an active ride.
 assert.equal((await h.webhook({...s,status:'complete',payment_status:'paid'})).status,200);assert.equal(h.records()[0].status,'cancelled');assert.equal(h.records()[0].paymentReviewRequired,true);assert.equal((await action(h,id,c)).status,409);
});
test('saved-card customer Checkout is never shared; account ownership is not inferred from contact and expired sessions may safely become payment-only',async t=>{
 const h=await create(t,{CUSTOMER_PAYMENT_METHODS_ENABLED:'true'}),c=await login(h),a=await h.request('/api/customer/register',{fullName:'Real Owner',email:booking.email,phone:booking.phone,password:'Synthetic account password'}),ownerCookie=cookie(a),r=await reserve(h,{}, {cookie:ownerCookie}),id=r.body.bookingId,owner=await h.testStore.reservationOwner(id);
 const owned=await h.request('/api/customer/trips/'+id+'/payment',{}, {cookie:ownerCookie,origin:'http://localhost:3000'});assert.equal(owned.status,200);const session=[...h.state.sessions.values()][0];assert.ok(session.customer);
 const denied=await action(h,id,c);assert.equal(denied.status,409);assert.match(denied.body.error,/account-specific/);assert.ok(!JSON.stringify(denied.body).includes(session.url));assert.equal(links(h).length,0);assert.equal(h.state.creates.length,1);
 session.status='expired';const shared=await action(h,id,c);assert.equal(shared.status,200);assert.equal(h.state.creates.length,2);assert.equal(h.state.creates[1].params.customer,undefined);assert.equal(h.state.creates[1].params.saved_payment_method_options,undefined);assert.equal(await h.testStore.reservationOwner(id),owner);assert.equal(h.records()[0].paymentStatus,'unpaid');
});
test('provider amount/identity/currency mismatch and unsafe URLs are rejected without email or a new payable reservation',async t=>{
 for(const mutation of ["s.amount_total=1","s.currency='eur'","s.metadata={bookingId:'another'}","s.url='https://attacker.example/payment'","s.customer='cus_unrelated'"]){
  const h=await create(t),c=await login(h),r=await reserve(h);vm.runInContext('const linkTamperCreate=stripe.checkout.sessions.create;stripe.checkout.sessions.create=async(...a)=>{const s=await linkTamperCreate(...a);'+mutation+';return s;};',h.context);
  const out=await action(h,r.body.bookingId,c,'email');assert.ok([409,503].includes(out.status));await flush(h);assert.equal(links(h).length,0);assert.equal(linkCalls(h).length,0);assert.equal(h.records().length,1);assert.equal(h.records()[0].quote.total,80);assert.equal(h.records()[0].paymentStatus,'unpaid');assert.ok(!JSON.stringify(out.body).includes('attacker.example'));
 }
});
test('EWR fixed offer stays exactly $150 and FIRST15 payment retries neither recalculate nor claim twice',async t=>{
 for(const extra of [{offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'},{promoCode:'FIRST15'}]){
  const h=await create(t),c=await login(h),a=await h.request('/api/customer/register',{fullName:'Discount Owner',email:booking.email,phone:booking.phone,password:'Synthetic account password'}),r=await reserve(h,extra,{cookie:cookie(a)});assert.equal(r.status,200);const amount=extra.offerCode?15000:6800;
  const first=await action(h,r.body.bookingId,c),next=await action(h,r.body.bookingId,c);assert.equal(first.status,200);assert.equal(next.status,200);assert.equal(first.body.url,next.body.url);assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,amount);assert.equal(h.records().length,1);assert.equal(h.testStore.shared.claims.size,extra.offerCode?0:2);
 }
});
test('email disabled fails before Checkout; a cancelled/paid/expired queued link is not delivered; provider failures do not leak data',async t=>{
 const disabled=await create(t,{BOOKING_EMAILS_ENABLED:'false'}),dc=await login(disabled),dr=await reserve(disabled);assert.equal((await action(disabled,dr.body.bookingId,dc,'email')).status,503);assert.equal(disabled.state.creates.length,0);assert.equal((await action(disabled,dr.body.bookingId,dc)).status,200);
 const h=await create(t),c=await login(h),r=await reserve(h),id=r.body.bookingId;await flush(h);h.state.emailFail=true;await action(h,id,c,'email');await flush(h);assert.equal(links(h)[0].state,'pending');const calls=linkCalls(h).length;
 await h.request('/api/bookings/'+id,{status:'cancelled'},{cookie:c,origin:'http://localhost:3000'},'PATCH');h.advance(30001);h.state.emailFail=false;await flush(h);assert.equal(links(h)[0].state,'inactive');assert.equal(linkCalls(h).length,calls);
});
test('admin revocation while Stripe responds cannot disclose a link or queue its email',async t=>{
 const h=await create(t),c=await login(h),r=await reserve(h),id=r.body.bookingId;await action(h,id,c);vm.runInContext('const linkOriginalRetrieve=stripe.checkout.sessions.retrieve;stripe.checkout.sessions.retrieve=async(...a)=>{const s=await linkOriginalRetrieve(...a);adminSessions.clear();return s;};',h.context);
 const out=await action(h,id,c,'email');assert.equal(out.status,401);assert.ok(!Object.hasOwn(out.body,'url'));assert.equal(links(h)[0].email_requested_at,null);assert.equal(linkCalls(h).length,0);
});

test('unknown email delivery reuses its immutable provider key; expired or already-paid queued links are retired',async t=>{
 for(const state of ['expired','paid']){
  const h=await create(t),c=await login(h),r=await reserve(h),id=r.body.bookingId;await flush(h);h.state.bookingLoseResponse=true;await action(h,id,c,'email');await flush(h);const first=structuredClone(linkCalls(h)[0]);assert.equal(links(h)[0].state,'pending');
  if(state==='expired'){h.advance(24*3600000+1);}else {const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';await h.webhook(session);h.advance(30001);}
  await flush(h);assert.equal(links(h)[0].state,state==='expired'?'review_required':'inactive');assert.equal(linkCalls(h).length,1);assert.equal(h.state.bookingMessages.filter(m=>m.idempotencyKey===first.idempotencyKey).length,1);
 }
});
test('admin link cannot replace processing Checkout or disclose saved-card/customer payment identifiers in its DTO',async t=>{
 const {adminDto}=require('../storage/admin-reservations'),h=await create(t),c=await login(h),r=await reserve(h),id=r.body.bookingId;await action(h,id,c);const s=[...h.state.sessions.values()][0];s.status='complete';s.payment_status='unpaid';assert.equal((await action(h,id,c)).status,409);
 const dto=adminDto(h.records()[0]);assert.equal(dto.canRequestPaymentLink,false);assert.equal(dto.paymentVerificationPending,true);assert.doesNotMatch(JSON.stringify(dto),/checkout\.stripe|cs_mock|customerAccess|tokenHash|pi_mock|parameters/);assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal(h.state.creates.length,1);
});

test('PostgreSQL admin payment links: additive migration, persisted amount/ownership, cross-worker locks, durable dedup/leases and rollback',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const u=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(u.hostname)&&u.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:u.toString()}),schema='admin_link_'+crypto.randomBytes(7).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const {createStore}=require('../storage/postgres'),a=createStore({},new Pool({connectionString:u.toString(),options:'-c search_path='+schema})),b=createStore({},new Pool({connectionString:u.toString(),options:'-c search_path='+schema})),sql=new Pool({connectionString:u.toString(),options:'-c search_path='+schema});
 t.after(async()=>{await a.close();await b.close();await sql.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await Promise.all([a.migrate(),b.migrate()]);await a.migrate();assert.equal((await sql.query('SELECT count(*)::int AS n FROM er_schema_migrations WHERE version=11')).rows[0].n,1);
 const h=await create(t,{},a),c=await login(h),r=await reserve(h),id=r.body.bookingId,original=structuredClone(await a.get(id));await flush(h);h.state.emailFail=true;assert.equal((await action(h,id,c,'email')).status,200);await flush(h);
 assert.equal((await sql.query('SELECT count(*)::int AS n FROM er_admin_payment_links')).rows[0].n,1);assert.equal((await action(h,id,c,'email')).status,200);await flush(h);assert.equal((await sql.query('SELECT count(*)::int AS n FROM er_admin_payment_links')).rows[0].n,1);
 const stored=await b.get(id),row=(await sql.query('SELECT * FROM er_admin_payment_links')).rows[0];assert.equal(stored.quote.total,80);assert.deepEqual(stored.quote,original.quote);assert.deepEqual(stored.trip,original.trip);assert.equal(await b.reservationOwner(id),null);assert.equal(row.state,'pending');assert.ok(row.email_requested_by);assert.equal(row.payload.to,booking.email);assert.equal(row.payload.text.includes(row.stripe_session_id),true);
 const key=stored.checkoutFingerprint || 'reservation:'+id;let ready,release;const held=new Promise(resolve=>ready=resolve),gate=new Promise(resolve=>release=resolve),locked=a.withActionLock(key,async()=>{ready();await gate;});await held;try{await assert.rejects(b.withActionLock(key,async()=>{}),e=>e.status===409);}finally{release();await locked;}
 let checks=0;await assert.rejects(a.withActionLock(key,()=>a.recordAdminPaymentLink({actorId:crypto.randomUUID(),authorized:()=>++checks===1},id,'copy',row.stripe_session_id,row.expires_at,null,Date.parse(row.created_at)+1)),e=>e.status===401);assert.equal((await sql.query('SELECT copied_at FROM er_admin_payment_links')).rows[0].copied_at,null);
 let now=Date.parse(row.created_at)+30001;const first=await a.claimAdminPaymentLinkEmail(now);assert.ok(first.claim_token);assert.equal(await b.claimAdminPaymentLinkEmail(now),null);now+=60001;const second=await b.claimAdminPaymentLinkEmail(now);assert.ok(second.claim_token);assert.notEqual(second.claim_token,first.claim_token);
 assert.equal(await a.prepareAdminPaymentLinkEmail(first.id,first.claim_token,{text:'tampered'},now),null);const prepared=await b.prepareAdminPaymentLinkEmail(second.id,second.claim_token,{text:'tampered'},now);assert.deepEqual(prepared.payload,row.payload);await b.finishAdminPaymentLinkEmail(second.id,second.claim_token,true,now);const sent=(await sql.query('SELECT * FROM er_admin_payment_links')).rows[0];assert.equal(sent.state,'sent');assert.equal(sent.payload,null);assert.ok(sent.sent_at);
 assert.equal((await sql.query("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname=$1 AND indexname='er_booking_email_original_event'",[schema])).rows[0].n,1);assert.equal((await b.get(id)).quote.total,original.quote.total);assert.equal((await sql.query('SELECT customer_id FROM er_reservations WHERE id=$1',[id])).rows[0].customer_id,null);
});
