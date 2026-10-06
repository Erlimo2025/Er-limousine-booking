const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{createRequire}=require('node:module'),{Pool}=require('pg');
const file=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(file,'utf8');
const {harness,booking}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(file),__dirname);
const {managementDto,DAY}=require('../services/trip-management'),{createStore}=require('../storage/postgres');
const account={fullName:'Trip Owner',email:'trip-owner@example.test',phone:'2025550171',password:'Synthetic trip owner password'},origin={origin:'http://localhost:3000','sec-fetch-site':'same-origin'};
const cookie=r=>r.headers.getSetCookie().find(x=>x.includes('er_customer_session'))?.split(';')[0];
const register=(h,extra={})=>h.request('/api/customer/register',{...account,...extra});
const detail=(h,id,c)=>h.request('/api/customer/trips/'+id,undefined,{cookie:c});
const action=(h,id,c,kind,body,headers={})=>h.request('/api/customer/trips/'+id+'/'+kind,body,{...origin,cookie:c,...headers});
const cancelBody=trip=>({requestId:crypto.randomUUID(),confirmed:true,expectedPickupAt:trip.management.pickupAt});
const timeBody=(trip,date='2026-11-11',time='13:30')=>({...cancelBody(trip),date,time});
async function setup(t,extra={},env={},store){
 const h=await harness(t,env,'[]',store),a=await register(h),c=cookie(a);
 const out=await h.request('/api/checkout',{...booking,paymentChoice:'later',...extra},{cookie:c});assert.equal(out.status,200);
 const id=out.body.bookingId,trip=(await detail(h,id,c)).body.trip;
 return {h,c,id,trip};
}
const events=h=>[...h.testStore.shared.tripEvents.values()];
const eventJobs=h=>[...h.testStore.shared.bookingEmails.values()].filter(j=>j.event_id);

test('unpaid/paid pickup edit inside 24h changes only schedule, keeps reservation/fare/payment/route and calls no Stripe',async t=>{
 for(const paid of [false,true]){
  const {h,c,id,trip}=await setup(t,{date:'2026-10-02',time:'10:00'});
  if(paid){await h.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c});const s=[...h.state.sessions.values()][0];s.status='complete';s.payment_status='paid';assert.equal((await h.webhook(s)).status,200);}
  const before=await h.testStore.get(id),creates=h.state.creates.length,google=h.state.googleCalls;
  assert.equal((await detail(h,id,c)).body.trip.management.canCancel,false);
  const body=timeBody(trip,'2026-10-02','11:00'),out=await action(h,id,c,'pickup-time',body);assert.equal(out.status,200);assert.equal(out.body.changed,true);
  const after=await h.testStore.get(id),expected=structuredClone(before);expected.trip.date=body.date;expected.trip.time=body.time;
  assert.deepEqual(after,expected);assert.equal(after.id,id);assert.equal(after.paymentStatus,paid?'paid':'unpaid');assert.equal(h.state.creates.length,creates);assert.equal(h.state.googleCalls,google);
  assert.equal(h.testStore.shared.tripRows.get(id).start,'2026-10-02T15:00:00.000Z');assert.equal(eventJobs(h).length,2);
  const event=events(h)[0];assert.equal(event.booking_id,id);assert.equal(event.customer_id,await h.testStore.reservationOwner(id));assert.equal(event.old_start_at,trip.management.pickupAt);assert.equal(event.new_start_at,'2026-10-02T15:00:00.000Z');assert.equal(event.details.oldTime,'10:00');assert.equal(event.details.newTime,'11:00');
  const replay=await action(h,id,c,'pickup-time',body);assert.equal(replay.status,200);assert.equal(replay.body.changed,false);assert.equal(events(h).length,1);assert.equal(eventJobs(h).length,2);
  assert.equal((await action(h,id,c,'pickup-time',{...body,time:'12:00'})).status,409);assert.equal(events(h).length,1);
 }
});

test('24-hour cancellation boundary is inclusive and recomputed from the updated authoritative New York schedule',async t=>{
 for(const [time,allowed]of [['12:01',true],['12:00',true],['11:59',false]]){
  const {h,c,id,trip}=await setup(t,{date:'2026-10-02',time});assert.equal(trip.management.canCancel,allowed);
  const out=await action(h,id,c,'cancel',cancelBody(trip));assert.equal(out.status,allowed?200:409);assert.equal((await h.testStore.get(id)).status,allowed?'cancelled':'awaiting_payment');
 }
 const {h,c,id,trip}=await setup(t,{date:'2026-10-02',time:'18:00'});
 let out=await action(h,id,c,'pickup-time',timeBody(trip,'2026-10-01','22:00'));assert.equal(out.status,200);assert.equal(out.body.trip.management.cancelReason,'within_24_hours');
 assert.equal((await action(h,id,c,'cancel',cancelBody(out.body.trip))).status,409);
 out=await action(h,id,c,'pickup-time',timeBody(out.body.trip,'2026-10-02','18:00'));assert.equal(out.status,200);assert.equal(out.body.trip.management.canCancel,true);
 assert.equal((await action(h,id,c,'cancel',cancelBody(out.body.trip))).status,200);
});

test('New York DST gap/overlap validation and absolute 24-hour elapsed time stay authoritative',async t=>{
 const {h,c,id,trip}=await setup(t);
 assert.equal((await action(h,id,c,'pickup-time',timeBody(trip,'2027-03-14','02:30'))).status,400);
 const out=await action(h,id,c,'pickup-time',timeBody(trip,'2026-11-01','01:30'));assert.equal(out.status,200);assert.equal(out.body.trip.management.pickupAt,'2026-11-01T05:30:00.000Z');
 const record=await h.testStore.get(id);
 for(const pickup of ['2027-03-14T07:30:00.000Z','2026-11-01T05:30:00.000Z']){
  const start=Date.parse(pickup);assert.equal(managementDto(record,pickup,pickup,start-DAY).canCancel,true);assert.equal(managementDto(record,pickup,pickup,start-DAY+1).canCancel,false);
 }
});

test('round-trip edits preserve return and reject crossing it; hourly edits shift end without repricing',async t=>{
 const a=await setup(t,{tripType:'roundtrip',returnDate:'2026-11-12',returnTime:'15:00'}),before=await a.h.testStore.get(a.id);
 let out=await action(a.h,a.id,a.c,'pickup-time',timeBody(a.trip));assert.equal(out.status,200);assert.equal(a.h.testStore.shared.tripRows.get(a.id).end,'2026-11-12T20:00:00.000Z');assert.equal((await a.h.testStore.get(a.id)).trip.returnDate,before.trip.returnDate);assert.deepEqual((await a.h.testStore.get(a.id)).quote,before.quote);
 assert.equal((await action(a.h,a.id,a.c,'pickup-time',timeBody(out.body.trip,'2026-11-12','15:00'))).status,409);
 const b=await setup(t,{tripType:'hourly',hours:3});out=await action(b.h,b.id,b.c,'pickup-time',timeBody(b.trip));assert.equal(out.status,200);assert.equal(b.h.testStore.shared.tripRows.get(b.id).end,'2026-11-11T21:30:00.000Z');assert.equal((await b.h.testStore.get(b.id)).quote.total,450);assert.equal(b.h.state.creates.length,0);
});

test('owner/session/origin/JSON/strict body protections deny foreign, guest and forged mutations without exposing authority',async t=>{
 const {h,c,id,trip}=await setup(t),b=await register(h,{email:'foreign-trip@example.test',phone:'2035550171'}),body=timeBody(trip);
 for(const kind of ['pickup-time','cancel']){
  const payload=kind==='cancel'?cancelBody(trip):body;
  const wrong=await action(h,id,cookie(b),kind,payload),missing=await action(h,crypto.randomUUID(),cookie(b),kind,payload);assert.equal(wrong.status,404);assert.equal(missing.status,404);assert.equal(wrong.body.error,missing.body.error);
  assert.equal((await action(h,id,'',kind,payload)).status,401);
  for(const headers of [{origin:'https://attacker.example'},{'sec-fetch-site':'cross-site'},{'content-type':'text/plain'}])assert.equal((await action(h,id,c,kind,payload,headers)).status,403);
  for(const payloadExtra of [{amount:1},{customer_id:'forged'},{confirmed:'true'},{confirmed:false},{requestId:'forged'}])assert.equal((await action(h,id,c,kind,{...payload,...payloadExtra})).status,400);
 }
 const good=await action(h,id,c,'pickup-time',body);assert.equal(good.status,200);assert.match(good.headers.get('cache-control'),/no-store/);assert.equal(good.headers.get('referrer-policy'),'no-referrer');
 for(const secret of ['customer_id','sessionHash','checkoutAttempt','stripeSessionId',account.email,account.phone])assert.ok(!JSON.stringify(good.body).includes(secret));
 await h.request('/api/customer/logout',{},{cookie:c});assert.equal((await action(h,id,c,'pickup-time',timeBody(good.body.trip))).status,401);
});

test('cancelled/completed/past service and invalid/past new dates cannot be edited',async t=>{
 for(const status of ['cancelled','completed']){const {h,c,id,trip}=await setup(t);await h.testStore.withActionLock(h.records()[0].checkoutFingerprint,()=>h.testStore.update(id,r=>{r.status=status;}));assert.equal((await action(h,id,c,'pickup-time',timeBody(trip))).status,409);}
 const {h,c,id,trip}=await setup(t,{date:'2026-10-01',time:'13:00'});h.advance(3600001);assert.equal((await action(h,id,c,'pickup-time',timeBody(trip))).status,409);
 const a=await setup(t);for(const [date,time,status]of [['2026-09-30','12:00',409],['2026-10-01','12:00',409],['2026-02-30','12:00',400],['2026-11-11','24:00',400]])assert.equal((await action(a.h,a.id,a.c,'pickup-time',timeBody(a.trip,date,time))).status,status);
});

test('unpaid cancellation is idempotent, retains history, releases FIRST15 only after locked safe transition and blocks payment',async t=>{
 const {h,c,id,trip}=await setup(t,{promoCode:'FIRST15'}),before=await h.testStore.get(id),body=cancelBody(trip);assert.equal(before.quote.total,85);assert.equal(before.quote.promotion.percentOff,15);assert.equal(h.testStore.shared.claims.size,2);
 const first=await action(h,id,c,'cancel',body);assert.equal(first.status,200);assert.equal(first.body.trip.status,'cancelled');assert.equal(first.body.trip.paymentStatus,'unpaid');assert.equal(h.testStore.shared.claims.size,0);assert.deepEqual((await h.testStore.get(id)).quote,before.quote);
 assert.equal((await action(h,id,c,'cancel',body)).body.changed,false);assert.equal((await action(h,id,c,'cancel',cancelBody(trip))).body.changed,false);assert.equal(events(h).length,1);assert.equal(eventJobs(h).length,2);
 assert.equal((await h.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c})).status,409);
 const fresh=await h.request('/api/checkout',{...booking,paymentChoice:'later',time:'13:00',promoCode:'FIRST15'},{cookie:c});assert.equal(fresh.status,200);assert.equal(h.state.creates.length,0);
});

test('open Checkout expires before customer cancellation, provider failure/lost expiry response fails closed then safely retries',async t=>{
 const {h,c,id,trip}=await setup(t,{promoCode:'FIRST15'});assert.equal((await h.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c})).status,200);const session=[...h.state.sessions.values()][0];
 h.state.retrieveError=true;assert.equal((await action(h,id,c,'cancel',cancelBody(trip))).status,503);assert.equal((await h.testStore.get(id)).status,'awaiting_payment');assert.equal(h.testStore.shared.claims.size,2);h.state.retrieveError=false;
 vm.runInContext('const originalExpire=stripe.checkout.sessions.expire;let loseExpiry=true;stripe.checkout.sessions.expire=async(...args)=>{const r=await originalExpire(...args);if(loseExpiry){loseExpiry=false;throw new Error("synthetic private expiry error");}return r;};',h.context);
 const body=cancelBody(trip);assert.equal((await action(h,id,c,'cancel',body)).status,503);assert.equal(session.status,'expired');assert.equal(h.testStore.shared.claims.size,2);assert.equal(events(h).length,0);
 assert.equal((await action(h,id,c,'cancel',body)).status,200);assert.equal(h.testStore.shared.claims.size,0);assert.equal(events(h).length,1);assert.equal(h.state.creates.length,1);assert.ok(!h.state.logs.join('').includes('synthetic private expiry error'));
});

test('ambiguous payment cannot be self-cancelled/refunded; payment evidence remains unchanged',async t=>{
 for(const mode of ['pending','lost']){
  const {h,c,id,trip}=await setup(t,{promoCode:'FIRST15'});
  if(mode==='lost')h.state.loseResponse=true;
  await h.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c});const session=[...h.state.sessions.values()][0];
  if(mode!=='lost'){session.status='complete';session.payment_status='paid';if(mode==='paid')await h.webhook(session);else await h.context.reconcileFirstRide(id);}
  const before=await h.testStore.get(id);assert.equal((await action(h,id,c,'cancel',cancelBody(trip))).status,409);assert.deepEqual(await h.testStore.get(id),before);assert.equal(events(h).length,0);assert.equal(h.state.creates.length,1);
  assert.equal((await detail(h,id,c)).body.trip.management.cancelReason,'payment_processing');
 }
});

test('Checkout creation and customer cancellation/time edits share the same action lock',async t=>{
 const {h,c,id,trip}=await setup(t,{promoCode:'FIRST15'});h.state.createDelay=80;const paying=h.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c});while(!h.state.creates.length)await new Promise(r=>setTimeout(r,2));
 assert.equal((await action(h,id,c,'cancel',cancelBody(trip))).status,409);assert.equal((await action(h,id,c,'pickup-time',timeBody(trip))).status,409);assert.equal(events(h).length,0);assert.equal(h.testStore.shared.claims.size,2);
 assert.equal((await paying).status,200);assert.equal((await action(h,id,c,'cancel',cancelBody(trip))).status,200);assert.equal([...h.state.sessions.values()][0].status,'expired');
});

test('webhook during expiry prevents unpaid customer cancellation; webhook after cancellation preserves cancelled-paid review',async t=>{
 for(const late of [false,true]){
  const {h,c,id,trip}=await setup(t);await h.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c});const session=[...h.state.sessions.values()][0];
  if(!late){h.context.onExpiry=async()=>{session.payment_status='paid';session.status='complete';assert.equal((await h.webhook(session)).status,200);};vm.runInContext('const originalExpire=stripe.checkout.sessions.expire;stripe.checkout.sessions.expire=async(...args)=>{const r=await originalExpire(...args);const snapshot={...r};await onExpiry();return snapshot;};',h.context);}
  assert.equal((await action(h,id,c,'cancel',cancelBody(trip))).status,late?200:409);
  if(late){session.payment_status='paid';session.status='complete';await h.webhook(session);await h.webhook(session);}
  const record=await h.testStore.get(id);assert.equal(record.paymentStatus,'paid');assert.equal(record.status,late?'cancelled':'confirmed');assert.equal(record.paymentReviewRequired===true,late);assert.equal(events(h).length,late?1:0);
 }
});

test('stale update/session revocation/write failure cannot mutate schedule or audit/outbox',async t=>{
 const {h,c,id,trip}=await setup(t),body=timeBody(trip);const first=await action(h,id,c,'pickup-time',body);assert.equal(first.status,200);
 assert.equal((await action(h,id,c,'pickup-time',{...body,requestId:crypto.randomUUID(),time:'14:00'})).status,409);assert.equal(events(h).length,1);
 h.storageFailures.write=true;assert.equal((await action(h,id,c,'pickup-time',timeBody(first.body.trip,'2026-11-12'))).status,503);h.storageFailures.write=false;assert.equal(events(h).length,1);assert.equal(eventJobs(h).length,2);
 const manage=h.testStore.manageCustomerTrip;h.testStore.manageCustomerTrip=async(...args)=>{h.testStore.shared.customerSessions.clear();return manage(...args);};assert.equal((await action(h,id,c,'pickup-time',timeBody(first.body.trip,'2026-11-12'))).status,401);assert.equal(events(h).length,1);
});

test('emails are durable per audit event, retries deduplicate and Resend failure cannot undo a time change/cancellation',async t=>{
 const {h,c,id,trip}=await setup(t,{}, {BOOKING_EMAILS_ENABLED:'true',COMPANY_EMAIL:'ops@example.test'});await h.context.runBookingEmails();h.state.emailFail=true;
 const body=timeBody(trip),updated=await action(h,id,c,'pickup-time',body);assert.equal(updated.status,200);assert.equal((await action(h,id,c,'pickup-time',body)).status,200);await h.context.runBookingEmails();assert.equal(eventJobs(h).length,2);assert.ok(eventJobs(h).every(j=>j.state==='pending'));
 const cancel=await action(h,id,c,'cancel',cancelBody(updated.body.trip));assert.equal(cancel.status,200);await h.context.runBookingEmails();assert.equal(eventJobs(h).length,4);assert.equal((await h.testStore.get(id)).status,'cancelled');
 h.state.emailFail=false;h.advance(60000);await h.context.runBookingEmails();assert.equal(h.state.bookingMessages.filter(m=>m.subject.startsWith('Pickup Time Updated')).length,2);assert.equal(h.state.bookingMessages.filter(m=>m.subject.startsWith('Trip Cancelled')).length,2);assert.ok(eventJobs(h).every(j=>j.state==='sent'));
 for(const forbidden of [account.email,account.phone,'synthetic email secret marker'])assert.ok(!h.state.logs.join('').includes(forbidden));
});

test('EWR $150/FIRST15 exclusion and Pay Now/Pay Later/Book Again retain their existing pricing and identity',async t=>{
 const h=await harness(t),c=cookie(await register(h));
 h.state.detailsById={'ChIJ2dQDPZNSwokRVJr9XE2SPt0':{id:'ChIJ2dQDPZNSwokRVJr9XE2SPt0',displayName:{text:'Terminal A'},formattedAddress:'3 Brewster Rd, Newark, NJ',types:['point_of_interest'],location:{latitude:40.6895,longitude:-74.1745}}};
 const payload={...booking,vehicle:'suv',pickup:'Newark Liberty International Airport Terminal A',pickupPlaceId:'ChIJ2dQDPZNSwokRVJr9XE2SPt0',offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'};
 const out=await h.request('/api/checkout',{...payload,paymentChoice:'later'},{cookie:c});assert.equal(out.status,200);const id=out.body.bookingId,trip=(await detail(h,id,c)).body.trip;
 const quote=await h.request('/api/quote',payload);assert.equal(quote.status,200);assert.equal(quote.body.total,150);assert.equal(quote.body.discount,0);assert.equal((await h.testStore.get(id)).quote.total,150);
 const before=await h.testStore.get(id);assert.equal((await action(h,id,c,'pickup-time',timeBody(trip))).status,200);assert.deepEqual((await h.testStore.get(id)).quote,before.quote);
 assert.equal((await h.request('/api/customer/trips/'+id+'/book-again',undefined,{cookie:c})).status,200);
});

test('PostgreSQL management: immutable audit/outbox, migration restart, owner/session checks and cross-worker payment locks',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(url.hostname));assert.ok(url.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:url.toString()}),schema='trip_management_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema}),pool2=new Pool({connectionString:url.toString(),options:'-c search_path='+schema}),store=createStore({},pool),other=createStore({},pool2);
 t.after(async()=>{await store.close();await other.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await store.migrate();
 const {h,c,id,trip}=await setup(t,{promoCode:'FIRST15'},{},store),owner=await store.reservationOwner(id),body=timeBody(trip),auth={id:owner,sessionHash:require('../auth/customers').hashToken(c.split('=')[1])};
 let changed=await action(h,id,c,'pickup-time',body);assert.equal(changed.status,200);assert.equal((await action(h,id,c,'pickup-time',body)).body.changed,false);
 let rows=(await pool.query('SELECT * FROM er_customer_trip_events WHERE booking_id=$1',[id])).rows;assert.equal(rows.length,1);assert.equal(rows[0].customer_id,owner);assert.equal(rows[0].old_start_at.toISOString(),trip.management.pickupAt);assert.equal(rows[0].new_start_at.toISOString(),'2026-11-11T18:30:00.000Z');
 assert.equal((await pool.query('SELECT count(*) FROM er_booking_email_outbox WHERE event_id=$1',[rows[0].id])).rows[0].count,'2');assert.equal((await pool.query('SELECT scheduled_start_at FROM er_reservations WHERE id=$1',[id])).rows[0].scheduled_start_at.toISOString(),'2026-11-11T18:30:00.000Z');
 await assert.rejects(pool.query("UPDATE er_customer_trip_events SET details='{}' WHERE id=$1",[rows[0].id]),/immutable/);await assert.rejects(pool.query('DELETE FROM er_customer_trip_events WHERE id=$1',[rows[0].id]),/immutable/);
 await Promise.all([store.migrate(),other.migrate()]);assert.deepEqual((await pool.query('SELECT version FROM er_schema_migrations ORDER BY version')).rows.map(r=>r.version),[1,2,3,4,5,6,7,8,9]);
 const current=await store.customerTripManagement(owner,id,Date.parse('2026-10-01T16:00:00Z')),record=await store.get(id),key=record.checkoutFingerprint;
 await store.withActionLock(key,async()=>{assert.equal((await action(h,id,c,'cancel',cancelBody(changed.body.trip))).status,409);await assert.rejects(other.withActionLock(key,()=>Promise.resolve()),e=>e.status===409);});
 await assert.rejects(other.manageCustomerTrip(auth,id,{kind:'customer_cancelled',...cancelBody(changed.body.trip)},Date.parse('2026-10-01T16:00:00Z'),{safe:true,sessionId:null}),e=>e.status===409);
 await pool.query("CREATE FUNCTION reject_trip_email() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id IS NOT NULL THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END $$");await pool.query('CREATE TRIGGER reject_trip_email BEFORE INSERT ON er_booking_email_outbox FOR EACH ROW EXECUTE FUNCTION reject_trip_email()');
 assert.equal((await action(h,id,c,'pickup-time',timeBody(changed.body.trip,'2026-11-12'))).status,503);assert.deepEqual(await store.get(id),record);assert.equal((await pool.query('SELECT count(*) FROM er_customer_trip_events')).rows[0].count,'1');await pool.query('DROP TRIGGER reject_trip_email ON er_booking_email_outbox');
 // Payment creation is blocked by a different worker's trip action. Cancellation expires it before claim release.
 await other.withActionLock(key,async()=>{assert.equal((await h.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c})).status,409);});assert.equal(h.state.creates.length,0);
 assert.equal((await h.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c})).status,200);h.state.retrieveError=true;assert.equal((await action(h,id,c,'cancel',cancelBody(changed.body.trip))).status,503);assert.equal((await pool.query('SELECT count(*) FROM er_first_ride_claims WHERE booking_id=$1',[id])).rows[0].count,'2');h.state.retrieveError=false;
 assert.equal((await action(h,id,c,'cancel',cancelBody(changed.body.trip))).status,200);assert.equal([...h.state.sessions.values()][0].status,'expired');assert.equal((await store.get(id)).status,'cancelled');assert.equal((await pool.query('SELECT count(*) FROM er_first_ride_claims WHERE booking_id=$1',[id])).rows[0].count,'0');
 assert.equal((await pool.query('SELECT count(*) FROM er_customer_trip_events')).rows[0].count,'2');assert.equal((await pool.query('SELECT count(*) FROM er_booking_email_outbox WHERE event_id IS NOT NULL')).rows[0].count,'4');
 const si=[...h.state.sessions.values()][0];si.payment_status='paid';si.status='complete';assert.equal((await h.webhook(si)).status,200);assert.equal((await store.get(id)).status,'cancelled');assert.equal((await store.get(id)).paymentReviewRequired,true);assert.equal((await h.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c})).status,409);
 assert.equal((await pool.query('SELECT count(*) FROM er_payment_ledger WHERE booking_id=$1',[id])).rows[0].count,'1');
 await Promise.all([store.migrate(),other.migrate()]);assert.equal((await other.customerTrip(owner,id,Date.parse('2026-10-01T16:00:00Z'))).management.canChangePickupTime,false);assert.equal(await other.customerTripManagement(crypto.randomUUID(),id,Date.now()),null);
 assert.equal(current.management.canCancel,true);
 const single=createStore({},new Pool({connectionString:url.toString(),options:'-c search_path='+schema,max:1,connectionTimeoutMillis:1000}));
 try{await single.withActionLock(key,async()=>{assert.equal((await single.customerTripManagement(owner,id,Date.now())).record.status,'cancelled');assert.equal((await single.customerTripManagementResponse(auth,id,Date.parse('2026-10-01T16:00:00Z'))).record.status,'cancelled');assert.equal((await single.tripEvent(rows[0].id,id)).booking_id,id);});}finally{await single.close();}
});
