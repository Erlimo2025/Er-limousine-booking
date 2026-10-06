const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{createRequire}=require('node:module'),{Pool}=require('pg');
const harnessPath=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(harnessPath,'utf8');
const {harness,booking}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(harnessPath),__dirname);
const headers={origin:'http://localhost:3000','sec-fetch-site':'same-origin'};
const customer={fullName:'Payment Owner',email:'pay-owner@example.test',phone:'2025550161',password:'Synthetic payment owner password'};
const cookie=r=>r.headers.getSetCookie().find(x=>x.includes('er_customer_session'))?.split(';')[0];
const register=(h,extra={})=>h.request('/api/customer/register',{...customer,...extra});
const reserve=(h,extra={},auth={})=>h.request('/api/checkout',{...booking,paymentChoice:'later',...extra},auth);
const payment=(h,id,c)=>h.request('/api/customer/trips/'+id+'/payment',{}, {...headers,cookie:c});
test('Pay Later stores server fare without Checkout; Pay Now uses the same fare and immutable suv identity',async t=>{
 for(const choice of ['later','now']){
 const h=await harness(t),r=await h.request('/api/checkout',{...booking,vehicle:'suv',paymentChoice:choice,amount:1,total:1,discount:100,customer_id:crypto.randomUUID()});
 assert.equal(r.status,200);assert.equal(h.records().length,1);assert.equal(h.records()[0].quote.total,80);assert.equal(h.records()[0].trip.vehicle,'suv');assert.equal(await h.testStore.reservationOwner(r.body.bookingId),null);
 assert.equal(h.state.creates.length,choice==='later'?0:1);assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal(h.records()[0].status,'awaiting_payment');
 assert.equal((await h.request('/api/checkout',{...booking,vehicle:'suv',paymentChoice:choice})).body.bookingId,r.body.bookingId);assert.equal(h.records().length,1);
 }
});
test('owned Complete Payment uses stored quote and SQL ownership; foreign, guest and missing access fail generically',async t=>{
 const h=await harness(t),a=await register(h),b=await register(h,{email:'second-pay@example.test',phone:'2035550161'}),r=await reserve(h,{}, {cookie:cookie(a)}),id=r.body.bookingId;
 const owner=await h.testStore.reservationOwner(id),before=h.state.googleCalls;
 const wrong=await payment(h,id,cookie(b)),missing=await payment(h,crypto.randomUUID(),cookie(b));assert.equal(wrong.status,404);assert.equal(missing.status,404);assert.equal(wrong.body.error,missing.body.error);
 assert.equal((await payment(h,id,'')).status,401);
 assert.equal((await h.request('/api/customer/trips/'+id+'/payment',{amount:1},{...headers,cookie:cookie(a)})).status,403);
 const paid=await payment(h,id,cookie(a));assert.equal(paid.status,200);assert.equal(h.state.googleCalls,before);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,10000);
 assert.equal(await h.testStore.reservationOwner(id),owner);assert.equal((await payment(h,id,cookie(a))).status,200);assert.equal(h.state.creates.length,1);
 const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';
 assert.equal((await h.request('/success.html?booking='+id+'&paid=true')).status,200);assert.equal(h.records()[0].paymentStatus,'unpaid');
 assert.equal((await h.webhook(session)).status,200);assert.equal((await h.webhook(session)).status,200);
 assert.equal(h.records()[0].paymentStatus,'paid');assert.equal((await payment(h,id,cookie(a))).status,409);assert.equal(h.state.creates.length,1);
});
test('guest Pay Later completion requires the existing high-entropy cookie and never claims matching account',async t=>{
 const h=await harness(t),a=await register(h),r=await reserve(h,{email:customer.email,phone:customer.phone}),id=r.body.bookingId;
 const access=r.headers.getSetCookie().find(x=>x.includes('er_booking_access_')).split(';')[0];
 assert.equal(await h.testStore.reservationOwner(id),null);
 assert.equal((await h.request('/api/booking/'+id+'/checkout',{},headers)).status,404);
 assert.equal((await h.request('/api/booking/'+id+'/checkout',{}, {...headers,cookie:cookie(a)})).status,404);
 assert.equal((await h.request('/api/booking/'+id+'/checkout',{}, {...headers,cookie:access.replace(/=.*/,'=forged')})).status,404);
 assert.equal((await h.request('/api/booking/'+id+'/checkout',{}, {...headers,cookie:access})).status,200);
 assert.equal(await h.testStore.reservationOwner(id),null);assert.equal(h.state.creates.length,1);
});
test('FIRST15 Pay Later claims are atomic, durable while payable, exactly 15%, and release only after paid/cancelled',async t=>{
 const h=await harness(t),a=await register(h),auth={cookie:cookie(a)},first=await reserve(h,{promoCode:'FIRST15'},auth),id=first.body.bookingId;
 assert.equal(first.status,200);assert.equal(h.records()[0].quote.total,85);assert.equal(h.records()[0].quote.promotion.percentOff,15);
 assert.equal((await reserve(h,{promoCode:'FIRST15',time:'13:00'},auth)).status,409);assert.equal(h.records().length,1);
 await h.testStore.update(id,r=>{r.dispatch.driver='Local chauffeur';});assert.equal(h.testStore.shared.claims.size,2);
 h.advance(60000);await h.context.reconcileFirstRide(id);assert.equal(h.testStore.shared.claims.size,2);
 const r=await payment(h,id,cookie(a));assert.equal(r.status,200);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,8500);
 const si=[...h.state.sessions.values()][0];si.status='expired';si.payment_status='unpaid';
 await h.context.reconcileFirstRide(id);assert.equal(h.testStore.shared.claims.size,2);
 assert.equal((await reserve(h,{promoCode:'FIRST15',time:'14:00'},auth)).status,409);
 assert.equal((await payment(h,id,cookie(a))).status,200);assert.equal(h.records().length,1);assert.equal(h.state.creates.at(-1).params.line_items[0].price_data.unit_amount,8500);
 const latest=[...h.state.sessions.values()].at(-1);latest.payment_status='paid';latest.status='complete';await h.webhook(latest);
 assert.equal(h.testStore.shared.claims.size,0);assert.equal((await reserve(h,{promoCode:'FIRST15',time:'15:00'},auth)).status,400);
});
test('Pay Now cancellation preserves one unpaid reservation; expiration renews Checkout on that reservation',async t=>{
 const h=await harness(t),a=await register(h),r=await h.request('/api/checkout',booking,{cookie:cookie(a)}),id=r.body.bookingId;
 assert.match(h.state.creates[0].params.cancel_url,new RegExp('success.html\\?booking='+id));
 const si=[...h.state.sessions.values()][0];si.status='expired';si.payment_status='unpaid';
 const next=await payment(h,id,cookie(a));assert.equal(next.status,200);assert.equal(next.body.bookingId,id);assert.equal(h.records().length,1);assert.equal(h.state.sessions.size,2);
});
test('concurrent reserve/payment calls are bounded and lost Checkout responses retry one provider identity',async t=>{
 const h=await harness(t),a=await register(h);
 const results=await Promise.all([reserve(h,{}, {cookie:cookie(a)}),reserve(h,{}, {cookie:cookie(a)})]);const good=results.find(x=>x.status===200);assert.ok(good);assert.equal(h.records().length,1);
 h.state.createDelay=50;h.state.loseResponse=true;
 const first=await payment(h,good.body.bookingId,cookie(a));assert.equal(first.status,503);
 assert.equal((await payment(h,good.body.bookingId,cookie(a))).status,200);assert.equal(h.state.sessions.size,1);
});
test('EWR special Pay Later and stored payment keep exactly $150, FIRST15 excluded, all terminal verification intact',async t=>{
 const terminals=require('../ewr-pickups');
 for(const [id,terminal] of Object.entries(terminals)){
 const h=await harness(t),a=await register(h);
 if(terminal.kind==='terminal')h.state.detailsById={[id]:{id,displayName:{text:terminal.label},formattedAddress:'3 Brewster Rd, Newark, NJ',types:['point_of_interest'],location:{latitude:40.6895,longitude:-74.1745}}};
 const r=await reserve(h,{vehicle:'suv',offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15',pickupPlaceId:id,pickup:terminal.kind==='airport'?'Newark Liberty International Airport (EWR)':terminal.label},{cookie:cookie(a)});
 assert.equal(r.status,200);assert.equal(h.records()[0].quote.total,150);assert.equal(h.records()[0].quote.promotion,null);
 assert.equal((await payment(h,r.body.bookingId,cookie(a))).status,200);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,15000);
 }
});
test('completion mutations enforce Origin, Fetch Metadata, JSON and no-store; provider failures remain sanitized',async t=>{
 const h=await harness(t),a=await register(h),r=await reserve(h,{}, {cookie:cookie(a)}),id=r.body.bookingId;
 for(const change of [{origin:'https://attacker.test'},{'sec-fetch-site':'cross-site'},{'content-type':'text/plain'}])assert.equal((await h.request('/api/customer/trips/'+id+'/payment',{}, {...headers,cookie:cookie(a),...change})).status,403);
 h.state.fail=new Error('private-provider-marker');const result=await payment(h,id,cookie(a));assert.equal(result.status,503);assert.equal(result.headers.get('cache-control'),'no-store');assert.ok(!JSON.stringify(result).includes('private-provider-marker'));
});
test('My Trips payment buttons depend on actual server payment status; confirmation ignores return claims',()=>{
 const text=fs.readFileSync(path.join(__dirname,'../public/account.js'),'utf8');assert.match(text,/trip.paymentStatus!=='paid'/);assert.match(text,/Complete Payment/);assert.match(text,/trips\/.*\/payment/);
 const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');assert.match(html,/RESERVE & PAY NOW/);assert.match(html,/RESERVE & PAY LATER/);
 const success=fs.readFileSync(path.join(__dirname,'../public/success.html'),'utf8');assert.ok(!success.includes("params.get('paid')"));assert.match(success,/b.paymentStatus==='paid'/);assert.match(success,/Payment Pending \/ Unpaid/);
});
test('PostgreSQL Pay Later: atomic FIRST15 creation, owner SQL, payment reuse and webhook authority',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const u=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:u.toString()}),schema='paylater_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:u.toString(),options:'-c search_path='+schema}),pool2=new Pool({connectionString:u.toString(),options:'-c search_path='+schema});
 const {createStore}=require('../storage/postgres'),store=createStore({},pool),other=createStore({},pool2);
 t.after(async()=>{await store.close();await other.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await Promise.all([store.migrate(),other.migrate()]);
 const h=await harness(t,{},'[]',store),worker=await harness(t,{},'[]',other);worker.state.sessions=h.state.sessions;
 const a=await register(h),b=await register(h,{email:'pgforeign-pay@example.test',phone:'2035550161'});
 const result=await reserve(h,{promoCode:'FIRST15'},{cookie:cookie(a)});assert.equal(result.status,200);const id=result.body.bookingId;
 assert.equal(h.state.creates.length,0);assert.equal((await store.get(id)).quote.total,85);
 const conflict=await reserve(worker,{promoCode:'FIRST15',time:'13:00'},{cookie:cookie(a)});assert.equal(conflict.status,409);
 assert.equal((await store.list()).length,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM er_first_ride_claims')).rows[0].n,2);
 await store.update(id,r=>{r.dispatch.driver='Synthetic driver';});assert.equal((await pool.query('SELECT count(*)::int AS n FROM er_first_ride_claims')).rows[0].n,2);
 assert.equal((await payment(worker,id,cookie(b))).status,404);
 const own=(await pool.query('SELECT customer_id FROM er_reservations WHERE id=$1',[id])).rows[0].customer_id;
 assert.ok(await store.customerReservation(own,id));assert.equal(await store.customerReservation(crypto.randomUUID(),id),null);
 const completed=await payment(worker,id,cookie(a));assert.equal(completed.status,200);assert.equal(worker.state.creates[0].params.line_items[0].price_data.unit_amount,8500);
 const mapping=(await pool.query('SELECT stripe_customer_id FROM er_customer_payment_mappings WHERE customer_id=$1',[own])).rows[0];
 assert.equal(worker.state.creates[0].params.customer,mapping.stripe_customer_id);
 assert.equal(worker.state.creates[0].params.saved_payment_method_options.payment_method_save,'enabled');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM er_customer_payment_mappings')).rows[0].n,1);
 assert.equal((await payment(h,id,cookie(a))).status,200);assert.equal(h.state.creates.length+worker.state.creates.length,1);
 const si=[...h.state.sessions.values()][0];si.status='complete';si.payment_status='paid';assert.equal((await h.webhook(si)).status,200);
 assert.equal((await store.get(id)).paymentStatus,'paid');assert.equal((await payment(worker,id,cookie(a))).status,409);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM er_first_ride_claims')).rows[0].n,0);
 assert.equal((await pool.query('SELECT customer_id FROM er_reservations WHERE id=$1',[id])).rows[0].customer_id,own);
});
test('booking choice double submit is blocked and browser sends only intent, never authoritative price',async()=>{
 const src=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),start=src.indexOf('form.addEventListener(\n  "submit"'),end=src.indexOf('/* =========================================',start+20);
 let handler,release,calls=0,sent;
 const ctx={form:{addEventListener:(e,f)=>handler=f},payBtn:{disabled:false},payLaterBtn:{disabled:false},reservationBusy:false,currentQuote:{total:80},vehicle:{disabled:false},clearNotice(){},getFormData:()=>({...booking,vehicle:'suv'}),showNotice(){},window:{location:{}},
 fetch:async(url,options)=>{calls++;sent=JSON.parse(options.body);await new Promise(r=>release=r);return {ok:true,json:async()=>({url:'http://localhost:3000/success.html?booking=fixture'})};}};
 vm.createContext(ctx);vm.runInContext(src.slice(start,end),ctx);
 const first=handler({preventDefault(){},submitter:{id:'payLaterBtn'}});await Promise.resolve();await handler({preventDefault(){},submitter:{id:'payLaterBtn'}});
 assert.equal(calls,1);assert.equal(sent.paymentChoice,'later');assert.equal(sent.vehicle,'suv');assert.ok(!Object.hasOwn(sent,'total'));assert.ok(!Object.hasOwn(sent,'amount'));release();await first;
});
test('confirmation page re-fetches status and never treats Stripe return parameters as Paid',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/success.html'),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1],events={},elements={};
 const node=()=>({children:[],hidden:false,disabled:false,textContent:'',append(...n){this.children.push(...n)},replaceChildren(){this.children=[]},addEventListener(k,f){this.events||={};this.events[k]=f}});
 for(const id of ['message','details','completePayment','refreshReservation'])elements[id]=node();
 let paid=false;
 const ctx={document:{getElementById:id=>elements[id],createElement:node},URLSearchParams,Intl,window:{addEventListener:(e,f)=>events[e]=f},location:{search:'?booking=11111111-1111-4111-8111-111111111111&paid=true&session_id=cs_forged',assign(){}},
 fetch:async()=>({ok:true,status:200,json:async()=>({id:'fixture',status:paid?'confirmed':'awaiting_payment',paymentStatus:paid?'paid':'unpaid',trip:{pickup:'<script>unsafe</script>',dropoff:'Destination',date:'2026-11-10',time:'12:00'},quote:{vehicle:'Luxury SUV',total:80,currency:'usd'}})})};
 vm.createContext(ctx);vm.runInContext(script,ctx);await events.pageshow();assert.match(elements.message.textContent,/Payment is still required/);assert.equal(elements.completePayment.hidden,false);assert.ok(elements.details.children.some(r=>r.children[1].textContent==='<script>unsafe</script>'));
 paid=true;await elements.refreshReservation.events.click();await new Promise(r=>setImmediate(r));assert.match(elements.message.textContent,/Payment received/);assert.equal(elements.completePayment.hidden,true);
});
test('revoked owner session during provider retrieval cannot receive the Checkout URL',async t=>{
 const h=await harness(t),a=await register(h),r=await reserve(h,{}, {cookie:cookie(a)});await payment(h,r.body.bookingId,cookie(a));
 h.context.revoke=()=>h.testStore.shared.customerSessions.clear();
 vm.runInContext('const oldRetrieve=stripe.checkout.sessions.retrieve;stripe.checkout.sessions.retrieve=async(...args)=>{const result=await oldRetrieve(...args);revoke();return result;};',h.context);
 assert.equal((await payment(h,r.body.bookingId,cookie(a))).status,401);assert.equal(h.state.creates.length,1);
});
test('guest credential expiry during provider lookup remains fail closed',async t=>{
 const h=await harness(t),r=await reserve(h),id=r.body.bookingId,access=r.headers.getSetCookie().find(x=>x.includes('er_booking_access_')).split(';')[0];
 await h.request('/api/booking/'+id+'/checkout',{}, {...headers,cookie:access});
 h.context.expireAccess=()=>h.advance(60*24*3600000);
 vm.runInContext('const oldRetrieve=stripe.checkout.sessions.retrieve;stripe.checkout.sessions.retrieve=async(...args)=>{const result=await oldRetrieve(...args);expireAccess();return result;};',h.context);
 assert.equal((await h.request('/api/booking/'+id+'/checkout',{}, {...headers,cookie:access})).status,401);assert.equal(h.state.creates.length,1);
});
test('FIRST15 cancellation never releases an open payment claim; unsubmitted or verified expired authority releases safely',async t=>{
 const h=await harness(t),a=await register(h),auth={cookie:cookie(a)};
 const first=await reserve(h,{promoCode:'FIRST15'},auth);await h.testStore.withActionLock(h.records().find(r=>r.id===first.body.bookingId).checkoutFingerprint,()=>h.testStore.update(first.body.bookingId,r=>{r.status='cancelled';}));assert.equal(h.testStore.shared.claims.size,0);
 const second=await reserve(h,{promoCode:'FIRST15',time:'13:00'},auth);assert.equal(second.status,200);await payment(h,second.body.bookingId,cookie(a));
 await h.testStore.withActionLock(h.records().find(r=>r.id===second.body.bookingId).checkoutFingerprint,()=>h.testStore.update(second.body.bookingId,r=>{r.status='cancelled';}));assert.equal(h.testStore.shared.claims.size,2);
 assert.equal((await reserve(h,{promoCode:'FIRST15',time:'14:00'},auth)).status,409);
 const si=[...h.state.sessions.values()][0];si.status='expired';si.payment_status='unpaid';await h.context.reconcileFirstRide(second.body.bookingId);assert.equal(h.testStore.shared.claims.size,0);
 assert.equal((await payment(h,second.body.bookingId,cookie(a))).status,409);
 assert.equal((await reserve(h,{promoCode:'FIRST15',time:'15:00'},auth)).status,200);
});
test('browser Back restores both booking controls without claiming payment success',()=>{
 const s=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),start=s.indexOf('// Restore booking controls after browser Back');
 let restore;const ctx={window:{addEventListener:(e,f)=>restore=f},reservationBusy:true,payBtn:{disabled:true,textContent:'Opening secure checkout'},payLaterBtn:{disabled:true},currentQuote:{total:100}};
 vm.createContext(ctx);vm.runInContext(s.slice(start),ctx);restore({persisted:true});assert.equal(ctx.reservationBusy,false);assert.equal(ctx.payBtn.disabled,false);assert.equal(ctx.payLaterBtn.disabled,false);assert.equal(ctx.payBtn.textContent,'RESERVE & PAY NOW');
 ctx.currentQuote=null;restore({persisted:true});assert.equal(ctx.payBtn.disabled,true);assert.equal(ctx.payLaterBtn.disabled,true);
});
const adminSession=async h=>(await h.request('/api/admin/login',{token:'local-test-token'})).headers.getSetCookie()[0].split(';')[0];
const cancel=async(h,id,admin)=>h.request('/api/bookings/'+id,{status:'cancelled'},{cookie:admin,origin:headers.origin},'PATCH');
test('cancellation during provider creation is serialized; open session expires before cancellation releases FIRST15',async t=>{
 const h=await harness(t),a=await register(h),admin=await adminSession(h),r=await reserve(h,{promoCode:'FIRST15'},{cookie:cookie(a)}),id=r.body.bookingId;
 h.state.createDelay=80;const pending=payment(h,id,cookie(a));
 while(!h.state.creates.length)await new Promise(r=>setTimeout(r,2));
 assert.equal((await cancel(h,id,admin)).status,409);assert.equal(h.records()[0].status,'awaiting_payment');assert.equal(h.testStore.shared.claims.size,2);
 assert.equal((await pending).status,200);assert.equal((await cancel(h,id,admin)).status,200);
 assert.equal([...h.state.sessions.values()][0].status,'expired');assert.equal(h.records()[0].status,'cancelled');assert.equal(h.testStore.shared.claims.size,0);
 assert.equal((await payment(h,id,cookie(a))).status,409);
});
test('prepared FIRST15 cancellation cannot release a claim from outside the owning action lock',async t=>{
 const h=await harness(t),a=await register(h),admin=await adminSession(h),r=await reserve(h,{promoCode:'FIRST15'},{cookie:cookie(a)}),id=r.body.bookingId;
 const resolve=h.testStore.resolveCustomerSession;let attempted=false;
 h.testStore.resolveCustomerSession=async(...args)=>{
  if(!attempted&&h.records()[0].checkoutAttempt?.state==='prepared'){
   attempted=true;assert.equal((await cancel(h,id,admin)).status,409);
   assert.equal((await reserve(h,{promoCode:'FIRST15',time:'13:00'},{cookie:cookie(a)})).status,409);
  }
  return resolve(...args);
 };
 assert.equal((await payment(h,id,cookie(a))).status,200);assert.ok(attempted);assert.equal(h.records().length,1);assert.equal(h.testStore.shared.claims.size,2);
});
test('lost response then later provider rejection retains generic attempt and identical idempotency parameters across restart',async t=>{
 const h=await harness(t),r=await reserve(h),id=r.body.bookingId,access=r.headers.getSetCookie().find(x=>x.includes('er_booking_access')).split(';')[0];
 const pay=()=>h.request('/api/booking/'+id+'/checkout',{}, {...headers,cookie:access});
 h.state.loseResponse=true;assert.equal((await pay()).status,503);const key=h.records()[0].checkoutAttempt.key;
 h.state.fail={type:'StripeInvalidRequestError',statusCode:400,code:'parameter_invalid_integer'};
 assert.equal((await pay()).status,503);assert.equal(h.records()[0].checkoutAttempt.key,key);
 const worker=await harness(t,{},'[]',h.testStore);worker.state.sessions=h.state.sessions;
 assert.equal((await worker.request('/api/booking/'+id+'/checkout',{}, {...headers,cookie:access})).status,200);
 assert.equal(h.state.sessions.size,1);assert.equal(worker.state.creates[0].options.idempotencyKey,h.state.creates[0].options.idempotencyKey);
 assert.deepEqual(JSON.parse(JSON.stringify(worker.state.creates[0].params)),JSON.parse(JSON.stringify(h.state.creates[0].params)));
});
test('API reconciliation records evidence and association but only signed webhook marks Paid',async t=>{
 const h=await harness(t),r=await h.request('/api/checkout',{...booking,promoCode:'FIRST15'}),si=[...h.state.sessions.values()][0];
 si.status='complete';si.payment_status='paid';await h.context.reconcileFirstRide(r.body.bookingId);
 assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal(h.records()[0].checkoutAttempt.evidence,'verified_paid_awaiting_webhook');assert.equal(h.testStore.shared.claims.size,2);
 assert.equal((await h.webhook(si,undefined,true)).status,400);assert.equal(h.records()[0].paymentStatus,'unpaid');
 assert.equal((await h.webhook(si)).status,200);assert.equal(h.records()[0].paymentStatus,'paid');assert.equal(h.testStore.shared.claims.size,0);
});
test('unsubmitted deferred holds cannot starve submitted reconciliation; guest eligibility hold expires safely after 24 hours',async t=>{
 const h=await harness(t);
 for(let i=0;i<10;i++)assert.equal((await reserve(h,{promoCode:'FIRST15',email:'hold'+i+'@example.test',phone:'202555'+String(i).padStart(4,'0')})).status,200);
 const submitted=await h.request('/api/checkout',{...booking,promoCode:'FIRST15',email:'submitted@example.test',phone:'2035550147'});
 const selected=await h.testStore.reconciliationCandidates(10);assert.equal(selected.length,1);assert.equal(selected[0].id,submitted.body.bookingId);
 const victim=await reserve(h,{promoCode:'FIRST15',email:'victim@example.test',phone:'2035550148'});assert.equal(victim.status,200);
 h.advance(25*3600000);await h.context.runFirstRideReconciliation();await h.context.runFirstRideReconciliation();
 const old=h.records().find(x=>x.id===victim.body.bookingId);assert.equal(old.status,'cancelled');assert.equal(old.cancellationReason,'first15_hold_expired');
 assert.equal((await reserve(h,{promoCode:'FIRST15',email:'victim@example.test',phone:'2035550148',time:'13:00'})).status,200);
 const access=victim.headers.getSetCookie().find(x=>x.includes('er_booking_access')).split(';')[0];
 assert.equal((await h.request('/api/booking/'+old.id+'/checkout',{}, {...headers,cookie:access})).status,409);
});
test('late payment on cancelled reservation stays cancelled with explicit operator-review state',async t=>{
 const h=await harness(t),a=await register(h),admin=await adminSession(h),r=await reserve(h,{}, {cookie:cookie(a)});
 await payment(h,r.body.bookingId,cookie(a));const si=[...h.state.sessions.values()][0];si.status='complete';si.payment_status='paid';
 assert.equal((await cancel(h,r.body.bookingId,admin)).status,200);
 assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal(h.records()[0].paymentReviewRequired,true);
 assert.equal((await h.webhook(si)).status,200);assert.equal(h.records()[0].paymentStatus,'paid');assert.equal(h.records()[0].status,'cancelled');
 assert.equal((await payment(h,r.body.bookingId,cookie(a))).status,409);
});
test('cancelled-but-paid confirmation explicitly requests review and never claims trip confirmation',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/success.html'),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1],events={},elements={};
 const node=()=>({children:[],hidden:false,textContent:'',append(...x){this.children.push(...x)},replaceChildren(){this.children=[]},addEventListener(){}});
 for(const id of ['message','details','completePayment','refreshReservation'])elements[id]=node();
 const ctx={document:{getElementById:id=>elements[id],createElement:node},URLSearchParams,Intl,window:{addEventListener:(e,f)=>events[e]=f},location:{search:'?booking=11111111-1111-4111-8111-111111111111'},
 fetch:async()=>({ok:true,status:200,json:async()=>({id:'fixture',status:'cancelled',paymentStatus:'paid',trip:{pickup:'Pickup',dropoff:'Destination',date:'2026-11-10',time:'12:00'},quote:{vehicle:'Luxury SUV',total:80,currency:'usd'}})})};
 vm.createContext(ctx);vm.runInContext(script,ctx);await events.pageshow();assert.match(elements.message.textContent,/cancelled reservation.*payment review/);assert.doesNotMatch(elements.message.textContent,/reservation is confirmed/);assert.equal(elements.completePayment.hidden,true);
});
test('PostgreSQL cancellation/claim transitions serialize across workers and expired holds do not starve reconciliation',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const u=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:u.toString()}),schema='payment_fix_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const p1=new Pool({connectionString:u.toString(),options:'-c search_path='+schema}),p2=new Pool({connectionString:u.toString(),options:'-c search_path='+schema}),{createStore}=require('../storage/postgres'),store=createStore({},p1),other=createStore({},p2);
 t.after(async()=>{await store.close();await other.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await Promise.all([store.migrate(),other.migrate()]);
 const h=await harness(t,{},'[]',store),worker=await harness(t,{},'[]',other);worker.state.sessions=h.state.sessions;
 const a=await register(h),adminCookie=await adminSession(worker),r=await reserve(h,{promoCode:'FIRST15'},{cookie:cookie(a)}),id=r.body.bookingId;
 h.state.createDelay=80;const pending=payment(h,id,cookie(a));while(!h.state.creates.length)await new Promise(r=>setTimeout(r,2));
 assert.equal((await cancel(worker,id,adminCookie)).status,409);assert.equal((await store.get(id)).status,'awaiting_payment');
 assert.equal((await pending).status,200);assert.equal((await cancel(worker,id,adminCookie)).status,200);assert.equal((await store.get(id)).status,'cancelled');
 assert.equal((await p1.query('SELECT count(*)::int AS n FROM er_first_ride_claims WHERE booking_id=$1',[id])).rows[0].n,0);
 for(let i=0;i<10;i++)assert.equal((await reserve(h,{promoCode:'FIRST15',email:'pg-hold'+i+'@example.test',phone:'202555'+String(i).padStart(4,'0')})).status,200);
 const submitted=await h.request('/api/checkout',{...booking,promoCode:'FIRST15',email:'pg-submitted@example.test',phone:'2035550178'});assert.equal(submitted.status,200);
 const selected=await other.reconciliationCandidates(10);assert.equal(selected.length,1);assert.equal(selected[0].id,submitted.body.bookingId);
 const si=h.state.sessions.get((await store.get(submitted.body.bookingId)).stripeSessionId);si.payment_status='paid';si.status='complete';
 await worker.context.reconcileFirstRide(submitted.body.bookingId);assert.equal((await store.get(submitted.body.bookingId)).paymentStatus,'unpaid');
 assert.equal((await p1.query('SELECT count(*)::int AS n FROM er_payment_ledger')).rows[0].n,0);
 assert.equal((await worker.webhook(si)).status,200);assert.equal((await store.get(submitted.body.bookingId)).paymentStatus,'paid');
 h.advance(25*3600000);await h.context.runFirstRideReconciliation();
 assert.equal((await p1.query("SELECT count(*)::int AS n FROM er_first_ride_claims")).rows[0].n,0);
 const expired=(await store.list()).filter(r=>r.customer.email.startsWith('pg-hold'));assert.equal(expired.length,10);assert.ok(expired.every(r=>r.status==='cancelled'));
});
test('24-hour deferred hold does not cancel active payment authority; verified expiry cancels before discounted renewal',async t=>{
 const h=await harness(t),a=await register(h),r=await reserve(h,{promoCode:'FIRST15'},{cookie:cookie(a)}),id=r.body.bookingId;
 const access=r.headers.getSetCookie().find(x=>x.includes('er_booking_access')).split(';')[0];
 const status=await h.request('/api/booking/'+id,undefined,{cookie:access});assert.equal(Date.parse(status.body.paymentHoldExpiresAt)-Date.parse(h.records()[0].createdAt),24*3600000);
 await payment(h,id,cookie(a));const si=[...h.state.sessions.values()][0];
 h.advance(25*3600000);await h.context.runFirstRideReconciliation();assert.equal(h.records()[0].status,'awaiting_payment');assert.equal(h.testStore.shared.claims.size,2);
 assert.equal((await payment(h,id,cookie(a))).status,200);assert.equal(h.state.sessions.size,1);
 si.status='expired';si.payment_status='unpaid';assert.equal((await payment(h,id,cookie(a))).status,409);
 assert.equal(h.records()[0].status,'cancelled');assert.equal(h.testStore.shared.claims.size,0);assert.equal(h.state.sessions.size,1);
 assert.equal((await reserve(h,{promoCode:'FIRST15',time:'13:00'},{cookie:cookie(a)})).status,200);
});
test('provider expiry failure cannot cancel a reservation or release its FIRST15 claim',async t=>{
 const h=await harness(t),a=await register(h),admin=await adminSession(h),r=await reserve(h,{promoCode:'FIRST15'},{cookie:cookie(a)});
 await payment(h,r.body.bookingId,cookie(a));vm.runInContext('stripe.checkout.sessions.expire=async()=>{throw Error("private-expiry-failure")};',h.context);
 const result=await cancel(h,r.body.bookingId,admin);assert.equal(result.status,503);assert.equal(h.records()[0].status,'awaiting_payment');assert.equal(h.testStore.shared.claims.size,2);assert.ok(!JSON.stringify(result.body).includes('private-expiry-failure'));
});

test('server payment evidence exposes only pending verification, cannot be forged, and never marks Paid',async t=>{
 const h=await harness(t),a=await register(h),r=await reserve(h,{paymentVerificationPending:true,paymentStatus:'paid'}, {cookie:cookie(a)}),id=r.body.bookingId;
 const own=()=>h.request('/api/customer/trips/'+id,undefined,{cookie:cookie(a)});
 assert.equal((await own()).body.trip.paymentVerificationPending,false);
 await payment(h,id,cookie(a));const si=[...h.state.sessions.values()][0];si.status='complete';si.payment_status='paid';
 assert.equal((await payment(h,id,cookie(a))).status,409);
 assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal((await own()).body.trip.paymentVerificationPending,true);
 const access=r.headers.getSetCookie().find(x=>x.includes('er_booking_access')).split(';')[0];
 const status=await h.request('/api/booking/'+id+'?paid=true&paymentVerificationPending=false',undefined,{cookie:access});
 assert.equal(status.body.paymentVerificationPending,true);assert.equal(status.body.paymentStatus,'unpaid');assert.ok(!('checkoutAttempt' in status.body));
 await h.webhook(si);assert.equal((await own()).body.trip.paymentStatus,'paid');assert.equal((await own()).body.trip.paymentVerificationPending,false);
});

test('signed pending/failure events update display evidence without granting Paid',async t=>{
 const h=await harness(t),r=await reserve(h);const access=r.headers.getSetCookie().find(x=>x.includes('er_booking_access')).split(';')[0];
 await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...headers,cookie:access});
 const si=[...h.state.sessions.values()][0];si.status='complete';si.payment_status='unpaid';
 await h.webhook(si);assert.equal(h.records()[0].paymentStatus,'unpaid');assert.equal(require('../storage/customer-trips').tripDto(h.records()[0]).paymentVerificationPending,true);
 await h.webhook(si,'checkout.session.async_payment_failed');assert.equal(require('../storage/customer-trips').tripDto(h.records()[0]).paymentVerificationPending,false);
});

test('confirmation messages and payment action use only server state, not URL claims',async()=>{
 const script=fs.readFileSync(path.join(__dirname,'../public/success.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
 for(const [status,paymentStatus,pending,visible,message] of [
 ['awaiting_payment','unpaid',false,true,/Payment is still required/],
 ['awaiting_payment','unpaid',true,false,/confirming your payment.*do not need to pay again/],
 ['confirmed','paid',false,false,/Payment received/],
 ['cancelled','unpaid',false,false,/cancelled/],['cancelled','unpaid',true,false,/cancelled/],['cancelled','paid',false,false,/payment review/]]){
 const events={},elements={};const node=()=>({children:[],hidden:false,textContent:'',append(...v){this.children.push(...v)},replaceChildren(){this.children=[]},addEventListener(){}});
 for(const id of ['message','details','completePayment','refreshReservation'])elements[id]=node();
 const ctx={document:{getElementById:id=>elements[id],createElement:node},URLSearchParams,Intl,window:{addEventListener:(e,f)=>events[e]=f},location:{search:'?booking=11111111-1111-4111-8111-111111111111&paid=true&paymentVerificationPending=true'},fetch:async()=>({ok:true,status:200,json:async()=>({id:'fixture',status,paymentStatus,paymentVerificationPending:pending,trip:{pickup:'Pickup',dropoff:'Destination',date:'2026-11-10',time:'12:00'},quote:{vehicle:'Luxury SUV',total:80,currency:'usd'}})})};
 vm.createContext(ctx);vm.runInContext(script,ctx);await events.pageshow();assert.equal(!elements.completePayment.hidden,visible);assert.match(elements.message.textContent,message);
 if(pending&&status!=='cancelled')assert.doesNotMatch(elements.message.textContent,/Payment is still required/);
 }
});

test('payment conflict refreshes authoritative status and removes repeat payment action',async()=>{
 const script=fs.readFileSync(path.join(__dirname,'../public/success.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1],events={},elements={},calls=[];
 const node=()=>({children:[],hidden:false,textContent:'',append(...x){this.children.push(...x)},replaceChildren(){this.children=[]},addEventListener(e,f){this[e]=f}});
 for(const id of ['message','details','completePayment','refreshReservation'])elements[id]=node();let reads=0;
 const ctx={document:{getElementById:id=>elements[id],createElement:node},URLSearchParams,Intl,window:{addEventListener:(e,f)=>events[e]=f},location:{search:'?booking=11111111-1111-4111-8111-111111111111',assign(){assert.fail('Processing payment must not redirect to another Checkout');}},fetch:async(url,options)=>{calls.push(options?.method||'GET');if(options?.method==='POST')return {ok:false,status:409};reads++;return {ok:true,status:200,json:async()=>({id:'fixture',status:'awaiting_payment',paymentStatus:'unpaid',paymentVerificationPending:reads>1,trip:{pickup:'Pickup',dropoff:'Destination',date:'2026-11-10',time:'12:00'},quote:{vehicle:'Luxury SUV',total:80,currency:'usd'}})};}};
 vm.createContext(ctx);vm.runInContext(script,ctx);await events.pageshow();assert.equal(elements.completePayment.hidden,false);await elements.completePayment.click();assert.deepEqual(calls,['GET','POST','GET']);assert.equal(elements.completePayment.hidden,true);assert.match(elements.message.textContent,/do not need to pay again/);
});

test('authenticated Checkout reuses saved-card Customer and optional consent; provider-saved cards appear in the existing list',async t=>{
 for(const checked of [false,true]){
 const h=await harness(t,{CUSTOMER_PAYMENT_METHODS_ENABLED:'true'}),a=await register(h),auth={...headers,cookie:cookie(a)},base='/api/customer/payment-methods';
 const setup=await h.request(base+'/setup',{consent:true},auth);assert.equal(setup.status,200);
 const mapped=[...h.testStore.shared.paymentMappings.values()][0].stripe_customer_id;
 const r=await h.request('/api/checkout',{...booking,vehicle:'suv',customer:'cus_forged',stripeCustomerId:'cus_forged',amount:1,setup_future_usage:'off_session'},auth);assert.equal(r.status,200);
 const p=h.state.creates[0].params;assert.equal(p.customer,mapped);assert.deepEqual(JSON.parse(JSON.stringify(p.saved_payment_method_options)),{payment_method_save:'enabled'});
 assert.ok(!Object.hasOwn(p,'customer_email'));assert.ok(!Object.hasOwn(p,'payment_intent_data'));assert.ok(!Object.hasOwn(p,'setup_future_usage'));assert.equal(p.line_items[0].price_data.unit_amount,8000);
 assert.equal(h.state.payments.customers.size,1);assert.equal(h.state.payments.setups.size,1);
 // Stripe controls checkbox consent and card attachment; the application never collects card data.
 if(checked)h.state.payments.cards.set('pm_checkout',{id:'pm_checkout',type:'card',customer:mapped,livemode:false,card:{brand:'visa',last4:'4242',exp_month:6,exp_year:2030}});
 const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';await h.webhook(session);
 const list=await h.request(base,undefined,auth);assert.equal(list.status,200);assert.equal(list.body.length,checked?1:0);
 if(checked)assert.deepEqual(Object.keys(list.body[0]).sort(),['id','brand','last4','expMonth','expYear'].sort());
 assert.ok(!h.state.logs.join(' ').includes(mapped));assert.equal(h.records()[0].paymentStatus,'paid');assert.equal((await payment(h,r.body.bookingId,cookie(a))).status,409);
 }
});

test('Pay Now and Complete Payment provision one shared Customer; open session reuse never adds a duplicate',async t=>{
 const h=await harness(t),a=await register(h),r=await h.request('/api/checkout',booking,{cookie:cookie(a)});assert.equal(r.status,200);
 const owner=await h.testStore.reservationOwner(r.body.bookingId),mapped=h.testStore.shared.paymentMappings.get(owner).stripe_customer_id;
 assert.equal(h.state.creates[0].params.customer,mapped);assert.equal(h.state.creates[0].params.saved_payment_method_options.payment_method_save,'enabled');assert.equal((await payment(h,r.body.bookingId,cookie(a))).status,200);assert.equal(h.state.creates.length,1);
 const later=await reserve(h,{time:'13:00'},{cookie:cookie(a)});assert.equal(later.status,200);assert.equal(h.state.creates.length,1);
 assert.equal((await payment(h,later.body.bookingId,cookie(a))).status,200);assert.equal(h.state.creates[1].params.customer,mapped);assert.equal(h.state.creates[1].params.saved_payment_method_options.payment_method_save,'enabled');assert.equal(h.state.payments.customers.size,1);
 assert.equal(h.state.payments.calls.filter(x=>x.op==='createCustomer').length,1);assert.equal(h.state.payments.setups.size,0);
 assert.equal(h.state.creates[1].params.line_items[0].price_data.unit_amount,10000);
});

test('guest and later-login guest retries cannot save into an account; anonymous access cannot reuse an account-bound Checkout',async t=>{
 const h=await harness(t),a=await register(h),guest=await reserve(h,{customer:'cus_forged',customer_id:[...h.testStore.shared.customers.keys()][0],saved_payment_method_options:{payment_method_save:'enabled'}});
 const access=guest.headers.getSetCookie().find(x=>x.includes('er_booking_access')).split(';')[0];
 assert.equal((await h.request('/api/booking/'+guest.body.bookingId+'/checkout',{}, {...headers,cookie:access+'; '+cookie(a)})).status,200);
 const p=h.state.creates[0].params;assert.ok(!Object.hasOwn(p,'customer'));assert.ok(!Object.hasOwn(p,'saved_payment_method_options'));assert.equal(h.state.payments.customers.size,0);assert.equal(await h.testStore.reservationOwner(guest.body.bookingId),null);
 const owned=await reserve(h,{time:'13:00'},{cookie:cookie(a)});assert.equal((await payment(h,owned.body.bookingId,cookie(a))).status,200);
 const ownAccess=owned.headers.getSetCookie().find(x=>x.includes('er_booking_access')).split(';')[0],before=h.state.creates.length;
 assert.equal((await h.request('/api/booking/'+owned.body.bookingId+'/checkout',{}, {...headers,cookie:ownAccess})).status,401);
 const b=await register(h,{email:'save-other@example.test',phone:'2035550179'});assert.equal((await payment(h,owned.body.bookingId,cookie(b))).status,404);
 assert.equal(h.state.creates.length,before);assert.equal(h.state.payments.customers.size,1);
});

test('lost Customer and Checkout responses retain durable Customer mapping and frozen payment parameters',async t=>{
 const h=await harness(t),a=await register(h);h.state.payments.loseCustomer=true;
 const first=await h.request('/api/checkout',booking,{cookie:cookie(a)});assert.equal(first.status,503);const id=h.records()[0].id;
 assert.equal(h.state.payments.customers.size,1);assert.equal(h.state.creates.length,0);
 h.state.loseResponse=true;assert.equal((await payment(h,id,cookie(a))).status,503);const frozen=JSON.stringify(h.records()[0].checkoutAttempt.parameters),key=h.state.creates[0].options.idempotencyKey;
 assert.equal((await payment(h,id,cookie(a))).status,200);assert.equal(h.state.payments.customers.size,1);assert.equal(h.state.sessions.size,1);
 assert.equal(JSON.stringify(h.records()[0].checkoutAttempt.parameters),frozen);assert.equal(h.state.creates[1].options.idempotencyKey,key);assert.equal(h.state.creates[0].params.customer,h.state.creates[1].params.customer);
});

test('concurrent owned payments and save-card setup cannot provision duplicate Stripe Customers',async t=>{
 const h=await harness(t,{CUSTOMER_PAYMENT_METHODS_ENABLED:'true'}),a=await register(h),r=await reserve(h,{}, {cookie:cookie(a)});h.state.payments.delay=30;
 const results=await Promise.all([payment(h,r.body.bookingId,cookie(a)),h.request('/api/customer/payment-methods/setup',{consent:true},{...headers,cookie:cookie(a)})]);
 assert.ok(results.some(x=>x.status===200));assert.equal(h.state.payments.customers.size,1);
 assert.equal((await payment(h,r.body.bookingId,cookie(a))).status,200);
 const setup=await h.request('/api/customer/payment-methods/setup',{consent:true},{...headers,cookie:cookie(a)});assert.equal(setup.status,200);
 const mapped=[...h.testStore.shared.paymentMappings.values()][0].stripe_customer_id;
 assert.equal(h.state.creates[0].params.customer,mapped);assert.equal([...h.state.payments.setups.values()][0].customer,mapped);assert.equal(h.state.sessions.size,1);
});

test('mapped Checkout never returns a mismatched provider Customer or a revoked-session save option',async t=>{
 const h=await harness(t),a=await register(h),r=await h.request('/api/checkout',booking,{cookie:cookie(a)});assert.equal(r.status,200);
 const session=[...h.state.sessions.values()][0];session.customer='cus_foreign';assert.equal((await payment(h,r.body.bookingId,cookie(a))).status,503);assert.equal(h.state.creates.length,1);
 const other=await harness(t),b=await register(other);other.state.payments.onCall=async()=>other.testStore.shared.customerSessions.clear();
 assert.equal((await other.request('/api/checkout',booking,{cookie:cookie(b)})).status,401);assert.equal(other.state.creates.length,0);
});

test('legacy open Checkout and frozen retries are reused without retrofitting save-card parameters',async t=>{
 const h=await harness(t),a=await register(h),r=await h.request('/api/checkout',booking,{cookie:cookie(a)});assert.equal(r.status,200);
 await h.testStore.update(r.body.bookingId,b=>{delete b.checkoutAttempt.parameters.customer;delete b.checkoutAttempt.parameters.saved_payment_method_options;b.checkoutAttempt.parameters.customer_email=b.customer.email;});
 const session=[...h.state.sessions.values()][0];session.customer=null;
 const original=JSON.stringify(h.records()[0].checkoutAttempt.parameters),calls=h.state.payments.calls.length;
 assert.equal((await payment(h,r.body.bookingId,cookie(a))).status,200);assert.equal(h.state.creates.length,1);
 assert.equal(JSON.stringify(h.records()[0].checkoutAttempt.parameters),original);assert.equal(h.state.payments.calls.length,calls);
});
