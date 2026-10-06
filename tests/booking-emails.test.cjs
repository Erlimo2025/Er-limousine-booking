const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{createRequire}=require('node:module'),{Pool}=require('pg');
const file=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(file,'utf8');
const {harness,booking}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(file),__dirname);
const env={BOOKING_EMAILS_ENABLED:'true',COMPANY_EMAIL:'ops@example.test',COMPANY_PHONE:'202-555-0100'};
const flush=h=>h.context.runBookingEmails();
const jobs=h=>[...h.testStore.shared.bookingEmails.values()];
test('application test workers wait for startup migration before exposing their helpers',async t=>{
 const store=require('./helpers/memory-storage.cjs').memoryStore();let ready=false;
 store.migrate=async()=>{await new Promise(resolve=>setTimeout(resolve,40));ready=true;};
 const h=await harness(t,{},'[]',store);assert.equal(ready,true);assert.equal(h.state.listenCalls,1);
});
test('new Pay Now/Pay Later reservations notify ER once with authoritative trip, contact, fare and unpaid intent',async t=>{
 for(const choice of ['now','later']){
  const h=await harness(t,env),r=await h.request('/api/checkout',{...booking,paymentChoice:choice,vehicle:'suv',flightNumber:'UA 1234',notes:'Meet at curb & wait',amount:1,paymentStatus:'paid'});assert.equal(r.status,200);await flush(h);
  assert.equal(h.state.bookingMessages.length,2);const m=h.state.bookingMessages.find(x=>x.to===env.COMPANY_EMAIL);assert.equal(m.to,env.COMPANY_EMAIL);
  for(const text of [r.body.bookingId,'Test Customer',booking.email,booking.phone,'UA 1234','Meet at curb & wait','Luxury SUV','$80.00','Unpaid',choice==='later'?'Pay Later':'Pay Now','America/New_York'])assert.ok(m.text.includes(text),text);
  const customerMail=h.state.bookingMessages.find(x=>x.to===booking.email);assert.match(customerMail.subject,/^Reservation Confirmed — Payment Due/);assert.match(customerMail.text,/successfully reserved.*Payment has not been completed and is still due/);for(const value of [r.body.bookingId,booking.pickup,booking.dropoff,'$80.00','Unpaid'])assert.ok(customerMail.text.includes(value));assert.doesNotMatch(customerMail.text,/https?:|er_booking_access|tokenHash/);
  assert.equal(h.state.creates.length,choice==='later'?0:1);assert.equal(h.records()[0].paymentStatus,'unpaid');
  assert.equal((await h.request('/api/checkout',{...booking,paymentChoice:choice,vehicle:'suv',flightNumber:'UA 1234',notes:'Meet at curb & wait'})).body.bookingId,r.body.bookingId);await flush(h);
  assert.equal(h.state.bookingMessages.length,2);assert.equal(jobs(h).length,2);assert.equal(jobs(h)[0].payload,null);
 }
});
test('only a signed Paid webhook queues customer confirmation; returns, pending events and retries cannot duplicate it',async t=>{
 const h=await harness(t,env),r=await h.request('/api/checkout',{...booking,promoCode:'FIRST15'});await flush(h);
 const si=[...h.state.sessions.values()][0];si.status='complete';
 await h.webhook(si);await h.request('/success.html?booking='+r.body.bookingId+'&paid=true');await flush(h);assert.equal(h.state.bookingMessages.length,2);
 si.payment_status='paid';await h.context.reconcileFirstRide(r.body.bookingId);await flush(h);assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal(h.state.bookingMessages.length,2);
 assert.equal((await h.webhook(si,undefined,true)).status,400);await flush(h);assert.equal(h.state.bookingMessages.length,2);
 assert.equal((await h.webhook({...si,customer_details:{email:'forged@example.test'}})).status,200);await flush(h);
 const m=h.state.bookingMessages.find(x=>x.to===booking.email&&x.subject.startsWith('Payment Confirmed'));assert.ok(m);assert.ok(m.text.includes('$85.00'));assert.match(m.text,/payment has been confirmed/);assert.ok(m.text.includes(r.body.bookingId));assert.ok(m.text.includes(env.COMPANY_PHONE));
 await Promise.all([h.webhook(si),h.webhook(si)]);await flush(h);assert.equal(h.state.bookingMessages.length,4);assert.equal(jobs(h).filter(x=>x.kind==='payment_confirmed').length,1);
 assert.equal(h.records()[0].paymentStatus,'paid');assert.deepEqual(jobs(h).map(x=>x.kind).sort(),['admin_payment_confirmed','customer_reservation_created','payment_confirmed','reservation_created']);assert.equal(h.state.bookingMessages.filter(x=>x.to===env.COMPANY_EMAIL&&x.subject.startsWith('Payment Confirmed')).length,1);
 for(const forbidden of ['stripeSessionId','checkoutFingerprint','tokenHash','cus_','cs_mock'])assert.ok(!m.text.includes(forbidden));
});
test('delivery failure is isolated from reservation creation and paid webhook state; safe retry succeeds',async t=>{
 const h=await harness(t,env);h.state.emailFail=true;const r=await h.request('/api/checkout',booking);assert.equal(r.status,200);await flush(h);
 assert.equal(h.records()[0].status,'awaiting_payment');assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal(jobs(h)[0].state,'pending');
 const si=[...h.state.sessions.values()][0];si.status='complete';si.payment_status='paid';assert.equal((await h.webhook(si)).status,200);await flush(h);
 assert.equal(h.records()[0].status,'confirmed');assert.equal(h.records()[0].paymentStatus,'paid');assert.equal(jobs(h).length,4);assert.ok(jobs(h).every(x=>x.state==='pending'));
 h.state.emailFail=false;h.advance(60000);await flush(h);assert.equal(h.state.bookingMessages.length,4);assert.ok(jobs(h).every(x=>x.state==='sent'&&x.payload===null));
 const logs=h.state.logs.join(' ');for(const privateText of [booking.email,booking.phone,'synthetic email secret marker','UA 1234'])assert.ok(!logs.includes(privateText));
});
test('lost Resend response and worker restart reuse one frozen message/key; ambiguity beyond 23 hours stops',async t=>{
 const h=await harness(t,env);h.state.bookingLoseResponse=true;const r=await h.request('/api/checkout',{...booking,notes:'Original notes'});await flush(h);
 const first=h.state.bookingMessages[0],lost=jobs(h).find(x=>'booking-email/'+x.id===first.idempotencyKey);assert.equal(lost.state,'pending');await h.testStore.update(r.body.bookingId,x=>{x.trip.notes='Changed notes';});
 const worker=await harness(t,env,'[]',h.testStore);worker.state.bookingMessages=h.state.bookingMessages;worker.state.bookingKeys=h.state.bookingKeys;worker.advance(60000);await flush(worker);
 assert.equal(worker.state.bookingMessages.length,2);assert.equal(worker.state.bookingCalls[0].idempotencyKey,first.idempotencyKey);assert.equal(worker.state.bookingCalls[0].text,first.text);assert.equal(lost.state,'sent');
 const aged=await harness(t,env);aged.state.bookingLoseResponse=true;await aged.request('/api/checkout',booking);await flush(aged);aged.advance(24*3600000);await flush(aged);
 assert.equal(aged.state.bookingCalls.length,2);assert.equal(jobs(aged).filter(x=>x.state==='review_required').length,1);assert.ok(jobs(aged).every(x=>x.payload===null));assert.equal(aged.records()[0].paymentStatus,'unpaid');
});
test('late payment on cancelled reservations sends accurate review wording, never trip confirmation',async t=>{
 const h=await harness(t,env),r=await h.request('/api/checkout',booking);await flush(h);
 await h.testStore.withActionLock(h.records()[0].checkoutFingerprint,()=>h.testStore.update(r.body.bookingId,x=>{x.status='cancelled';}));
 const si=[...h.state.sessions.values()][0];si.status='complete';si.payment_status='paid';await h.webhook(si);await flush(h);
 const m=h.state.bookingMessages.find(x=>x.to===booking.email&&x.subject.startsWith('Payment Confirmed'));assert.match(m.text,/cancelled.*payment review/);assert.doesNotMatch(m.text,/reservation is confirmed/);assert.equal(h.records()[0].status,'cancelled');assert.equal(h.records()[0].paymentReviewRequired,true);assert.match(h.state.bookingMessages.find(x=>x.to===env.COMPANY_EMAIL&&x.subject.startsWith('Payment Confirmed')).text,/cancelled.*payment review/);
});
test('booking flag remains independent of recovery; disabled delivery queues without affecting checkout',async t=>{
 const h=await harness(t,{...env,BOOKING_EMAILS_ENABLED:'false'});await h.request('/api/checkout',booking);await flush(h);assert.equal(h.state.bookingMessages.length,0);assert.equal(jobs(h)[0].state,'pending');
 const onlyBooking=await harness(t,env);assert.equal((await onlyBooking.request('/api/customer/recovery/request',{email:booking.email},{origin:'http://localhost:3000'})).status,503);
 const existing=await harness(t,{CUSTOMER_EMAIL_RECOVERY_ENABLED:'true',COMPANY_EMAIL:env.COMPANY_EMAIL});await existing.request('/api/checkout',booking);await flush(existing);assert.equal(existing.state.bookingMessages.length,2);
 const broken=await harness(t,{...env,TEST_RECOVERY_CONFIG_FAILURE:true});assert.equal((await broken.request('/api/checkout',booking)).status,200);await flush(broken);assert.equal(broken.records()[0].paymentStatus,'unpaid');assert.equal(broken.state.bookingMessages.length,0);
});
test('shared Resend adapter escapes email content, uses bounded request/key, and never reads provider bodies',async()=>{
 const {bookingMessage}=require('../services/booking-emails'),{createEmailProvider}=require('../services/email'),r={id:crypto.randomUUID(),status:'awaiting_payment',paymentStatus:'unpaid',customer:{firstName:'<script>x</script>',lastName:'& Owner',email:'person@example.test',phone:'2025550101'},trip:{pickup:'<img src=x>',dropoff:'Destination',date:'2026-10-21',time:'12:00',vehicle:'suv',passengers:3,notes:'<b>notes</b>'},quote:{total:150,currency:'usd'},deferredPayment:true};
 const m=bookingMessage(r,'reservation_created',{email:env.COMPANY_EMAIL,phone:env.COMPANY_PHONE});assert.equal(m.to,env.COMPANY_EMAIL);assert.ok(!m.html.includes('<script>'));assert.ok(!m.html.includes('<img'));assert.ok(m.html.includes('&lt;script&gt;'));assert.ok(m.html.includes('&lt;b&gt;'));
 const calls=[],provider=createEmailProvider({enabled:true,apiKey:'synthetic-only-key',from:'accounts@erlimousineservice.com',siteUrl:'http://localhost:3000',fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json(){assert.fail('Raw provider body must not be read');}};}});
 const key='booking-email/'+crypto.randomUUID();await provider.sendBookingEmail({...m,to:'ops@example.test',idempotencyKey:key});assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.resend.com/emails');assert.ok(calls[0].options.signal instanceof AbortSignal);assert.equal(calls[0].options.headers['Idempotency-Key'],key);assert.ok(!('click_tracking' in JSON.parse(calls[0].options.body)));
 await assert.rejects(provider.sendBookingEmail({...m,to:'injected\r\n@example.test',idempotencyKey:key}));assert.equal(calls.length,1);
});

test('PostgreSQL booking emails: atomic outbox, cross-worker dedup, delivery fault isolation, leases and expired ambiguity',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const u=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:u.toString()}),schema='mail_test_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const p1=new Pool({connectionString:u.toString(),options:'-c search_path='+schema,application_name:schema}),p2=new Pool({connectionString:u.toString(),options:'-c search_path='+schema,application_name:schema}),{createStore}=require('../storage/postgres'),a=createStore({},p1),b=createStore({},p2);
 t.after(async()=>{await a.close();await b.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await Promise.all([a.migrate(),b.migrate()]);
 const h=await harness(t,env,'[]',a);h.state.emailFail=true;
 const r=await h.request('/api/checkout',{...booking,paymentChoice:'later'});assert.equal(r.status,200);await flush(h);
 assert.equal((await p1.query('SELECT count(*)::int AS n FROM er_booking_email_outbox')).rows[0].n,2);
 const cookie=r.headers.getSetCookie().find(x=>x.includes('er_booking_access')).split(';')[0];
 assert.equal((await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {cookie,origin:'http://localhost:3000'})).status,200);
 const si=[...h.state.sessions.values()][0];si.status='complete';si.payment_status='paid';assert.equal((await h.webhook(si)).status,200);await flush(h);
 assert.equal((await a.get(r.body.bookingId)).paymentStatus,'paid');assert.equal((await p1.query('SELECT count(*)::int AS n FROM er_booking_email_outbox')).rows[0].n,4);
 await Promise.all([h.webhook(si),h.webhook(si)]);await flush(h);assert.equal((await p1.query('SELECT count(*)::int AS n FROM er_booking_email_outbox')).rows[0].n,4);
 h.state.emailFail=false;
 h.state.bookingOnCall=async()=>{const open=await p2.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid() AND xact_start IS NOT NULL',[schema]);assert.equal(open.rowCount,0,'Email network submission must occur outside DB transactions');};
 await p1.query("CREATE FUNCTION fail_mail_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='sent' THEN RAISE EXCEPTION 'synthetic delivery bookkeeping fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_mail_finish BEFORE UPDATE ON er_booking_email_outbox FOR EACH ROW EXECUTE FUNCTION fail_mail_finish()");
 h.advance(60000);await flush(h);assert.equal(h.state.bookingMessages.length,4);assert.equal((await a.get(r.body.bookingId)).paymentStatus,'paid');assert.equal((await p1.query('SELECT count(*)::int AS n FROM er_payment_ledger')).rows[0].n,1);
 await p1.query('DROP TRIGGER fail_mail_finish ON er_booking_email_outbox; DROP FUNCTION fail_mail_finish()');h.advance(60000);await flush(h);
 assert.equal(h.state.bookingMessages.length,4);assert.ok((await p1.query('SELECT state,payload FROM er_booking_email_outbox')).rows.every(x=>x.state==='sent'&&x.payload===null));
 h.state.emailFail=true;await h.request('/api/checkout',{...booking,time:'13:00',paymentChoice:'later'});await flush(h);h.state.bookingOnCall=null;
 const now=h.context.Date.now()+61000,first=await a.claimBookingEmail(now);assert.ok(first);const second=await b.claimBookingEmail(now);assert.ok(second);assert.notEqual(first.id,second.id);assert.equal(await b.claimBookingEmail(now),null);await b.finishBookingEmail(second.id,second.claim_token,true,now);
 const replacement=await b.claimBookingEmail(now+61000);assert.notEqual(replacement.claim_token,first.claim_token);
 await a.finishBookingEmail(first.id,first.claim_token,true,now+61000);
 assert.equal((await p1.query('SELECT state FROM er_booking_email_outbox WHERE id=$1',[first.id])).rows[0].state,'sending');
 await b.finishBookingEmail(replacement.id,replacement.claim_token,false,now+61000);
 await p1.query("UPDATE er_booking_email_outbox SET first_submitted_at=$2,next_attempt_at=$3 WHERE id=$1",[first.id,new Date(now-24*3600000),new Date(now+61000)]);
 assert.equal((await b.claimBookingEmail(now+62000)).reviewRequired,true);
 assert.equal((await p1.query('SELECT state,payload FROM er_booking_email_outbox WHERE id=$1',[first.id])).rows[0].state,'review_required');
 assert.equal((await p1.query('SELECT 1 FROM er_schema_migrations WHERE version=8')).rowCount,1);
 assert.match((await p1.query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='er_booking_email_due'",[schema])).rows[0].indexdef,/next_attempt_at, id/);
});

 test('customer reservation links require relational ownership, never matching guest email/phone',async t=>{
 const h=await harness(t,env),a=await h.request('/api/customer/register',{fullName:'Test Customer',email:booking.email,phone:booking.phone,password:'Synthetic payment owner password'});
 assert.equal(a.status,201);const cookie=a.headers.getSetCookie().find(x=>x.includes('er_customer_session')).split(';')[0];
 const owned=await h.request('/api/checkout',{...booking,paymentChoice:'later'},{cookie});assert.equal(owned.status,200);await flush(h);
 const mail=h.state.bookingMessages.find(x=>x.to===booking.email&&x.text.includes(owned.body.bookingId));assert.match(mail.text,/http:\/\/localhost:3000\/account\/dashboard/);assert.match(mail.html,/Open My Trips \/ Complete Payment/);
 const guest=await h.request('/api/checkout',{...booking,time:'14:00',paymentChoice:'later'});assert.equal(guest.status,200);await flush(h);
 const guestMail=h.state.bookingMessages.find(x=>x.to===booking.email&&x.text.includes(guest.body.bookingId));assert.doesNotMatch(guestMail.text,/https?:|tokenHash|er_booking_access/);assert.doesNotMatch(guestMail.html,/href=/);
 });

const presentationRecord=()=>({id:crypto.randomUUID(),status:'awaiting_payment',paymentStatus:'unpaid',customer:{firstName:'Test',lastName:'Customer',email:'person@example.test',phone:'2025550101'},trip:{pickup:'Terminal A, Terminal A, 3 Brewster Rd, Newark, NJ 07114, USA',dropoff:'Manhattan',date:'2026-11-10',time:'12:00',returnDate:'2026-11-12',returnTime:'18:00',vehicle:'suv',passengers:3},quote:{total:150,currency:'usd'},deferredPayment:true});
test('customer reservation presentation uses Total, New York time and concise subject without changing record or admin details',()=>{
 const {bookingMessage}=require('../services/booking-emails'),r=presentationRecord(),before=JSON.stringify(r),m=bookingMessage(r,'customer_reservation_created',envContact());
 assert.equal(m.subject,'Reservation Confirmed — Payment Due | ER Limousine Service');assert.ok(!m.subject.includes(r.id));assert.ok(m.text.includes('Reservation ID: '+r.id));assert.ok(m.html.includes(r.id));
 assert.match(m.text,/Total: \$150\.00/);assert.match(m.html,/>Total<\/th>/);assert.doesNotMatch(m.text+m.html,/Authoritative total|America\/New_York/);
 for(const dt of ['2026-11-10 12:00 (New York time)','2026-11-12 18:00 (New York time)'])assert.ok(m.text.includes(dt));
 assert.equal(JSON.stringify(r),before);const admin=bookingMessage(r,'reservation_created',envContact());assert.ok(admin.subject.includes(r.id));assert.match(admin.text,/Authoritative total: \$150\.00/);assert.match(admin.text,/America\/New_York/);assert.ok(admin.text.includes(r.trip.pickup));
});
function envContact(){return {email:env.COMPANY_EMAIL,phone:env.COMPANY_PHONE};}
test('customer emails deduplicate only repeated A/B/C terminal labels and preserve address and stored pickup',()=>{
 const {bookingMessage}=require('../services/booking-emails');
 for(const terminal of ['A','B','C'])for(const kind of ['customer_reservation_created','payment_confirmed']){
  const r=presentationRecord();r.trip.pickup='Terminal '+terminal+', Terminal '+terminal+', 3 Brewster Rd, Newark, NJ 07114, USA';if(kind==='payment_confirmed')r.paymentStatus='paid';const original=r.trip.pickup,m=bookingMessage(r,kind,envContact()),expected='Terminal '+terminal+', 3 Brewster Rd, Newark, NJ 07114, USA';
  assert.ok(m.text.includes('Pickup: '+expected));assert.ok(m.html.includes(expected));assert.ok(!m.text.includes(original));assert.equal(r.trip.pickup,original);
 }
 for(const address of ['Terminal B, 3 Brewster Rd, Newark, NJ 07114, USA','Terminal A, Terminal B, 3 Brewster Rd','123 Terminal Avenue, Newark, NJ','Terminal C, terminal c, Terminal C, 3 Brewster Rd']){
  const r=presentationRecord();r.trip.pickup=address;const m=bookingMessage(r,'customer_reservation_created',envContact());assert.ok(m.text.includes('Pickup: '+(address.startsWith('Terminal C, terminal')?'Terminal C, 3 Brewster Rd':address)));assert.equal(r.trip.pickup,address);
 }
});
test('customer payment and terminal reservation subjects stay concise while body and admin preserve reservation ID',()=>{
 const {bookingMessage}=require('../services/booking-emails'),r=presentationRecord();r.paymentStatus='paid';
 const paid=bookingMessage(r,'payment_confirmed',envContact());assert.equal(paid.subject,'Payment Confirmed | ER Limousine Service');assert.ok(!paid.subject.includes(r.id));assert.ok(paid.text.includes(r.id));assert.match(paid.text,/Amount paid: \$150\.00/);assert.match(paid.text,/New York time/);
 assert.equal(bookingMessage(r,'admin_payment_confirmed',envContact()).subject,'Payment Confirmed — '+r.id);
 assert.equal(bookingMessage(r,'customer_reservation_created',envContact()).subject,'Reservation Confirmed | ER Limousine Service');r.status='cancelled';assert.equal(bookingMessage(r,'customer_reservation_created',envContact()).subject,'Reservation Cancelled | ER Limousine Service');assert.match(bookingMessage(r,'payment_confirmed',envContact()).text,/cancelled.*payment review/);
});
