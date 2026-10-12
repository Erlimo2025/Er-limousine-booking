const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{createRequire}=require('node:module'),{Pool}=require('pg');
const harnessPath=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(harnessPath,'utf8');
const {harness}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness};')(createRequire(harnessPath),__dirname);
const {adminQuery,searchSql}=require('../storage/admin-reservations'),{canArchive}=require('../storage/admin-archives');
const now=Date.parse('2026-10-01T16:00:00Z'),headers={origin:'http://localhost:3000','sec-fetch-site':'same-origin'};
const record=(extra={})=>({id:crypto.randomUUID(),createdAt:'2026-09-20T12:00:00Z',status:'completed',paymentStatus:'paid',paidAt:'2026-09-20T12:00:00Z',stripeSessionId:'cs_test_historical',customer:{firstName:'Archive',lastName:'Passenger',email:'archive@example.test',phone:'2015550199'},trip:{pickup:'Newark Liberty International Airport',dropoff:'Manhattan',date:'2026-10-02',time:'12:00',tripType:'oneway',vehicle:'suv',passengers:2},quote:{total:150,currency:'usd',vehicle:'Luxury SUV',vehicleKey:'suv'},dispatch:{driver:'Original chauffeur',driverPhone:'2015550198',vehicle:'Suburban',plate:'TEST'},...extra});
const cookie=r=>r.headers.getSetCookie()[0].split(';')[0];
const login=async h=>cookie(await h.request('/api/admin/login',{token:'local-test-token'}));
const input=()=>({confirmed:true,requestId:crypto.randomUUID()});
const action=(h,id,c,kind='archive',body=input(),extra={})=>h.request('/api/bookings/'+id+'/'+kind,body,{...headers,cookie:c,...extra});

test('archive/restore require an active admin session, canonical Origin and exact confirmed input; customers/guests/forged ownership fail',async t=>{
 const r=record(),h=await harness(t,{},JSON.stringify([r])),c=await login(h);
 assert.equal((await action(h,r.id,'')).status,401);
 const customer=await h.request('/api/customer/register',{fullName:'Unrelated Customer',email:'unrelated-archive@example.test',phone:'2025550199',password:'Synthetic archive account password'});
 for(const kind of ['archive','restore'])assert.equal((await action(h,r.id,cookie(customer),kind)).status,401);
 for(const extra of [{origin:'https://attacker.example.test'},{origin:''},{'sec-fetch-site':'cross-site'},{'content-type':'text/plain'}])assert.equal((await action(h,r.id,c,'archive',input(),extra)).status,403);
 for(const bad of [{},[],{...input(),confirmed:false},{...input(),requestId:'forged'},{...input(),customer_id:crypto.randomUUID()},{...input(),actorId:crypto.randomUUID()},{...input(),amount:1}])assert.equal((await action(h,r.id,c,'archive',bad)).status,400);
 assert.equal((await action(h,'bad-id',c)).status,400);assert.equal((await action(h,crypto.randomUUID(),c)).status,404);
 assert.equal(h.testStore.shared.archiveEvents.size,0);assert.deepEqual(h.records()[0],r);
 await h.request('/api/admin/logout',{},{cookie:c});assert.equal((await action(h,r.id,c)).status,401);
});

test('soft archive/restore persist independently of JSON, preserve claims/dispatch/payment/ownership and replay safely across sessions',async t=>{
 const r=record({status:'cancelled',paymentStatus:'unpaid',deferredPayment:true}),h=await harness(t,{},JSON.stringify([r])),c=await login(h),request=input();
 const owner=crypto.randomUUID();h.testStore.shared.tripRows.set(r.id,{customer_id:owner,start:'2026-10-02T16:00:00Z',end:'2026-10-02T16:00:00Z'});h.testStore.shared.claims.set('synthetic-first15-claim',r.id);
 const before=h.records(),first=await action(h,r.id,c,'archive',request);assert.equal(first.status,200);assert.equal(first.body.changed,true);
 const archived=await h.testStore.adminArchiveState(r.id);assert.equal(archived.archived_at,new Date(now).toISOString());assert.match(archived.archived_by,/^[a-f0-9-]{36}$/);
 assert.equal((await action(h,r.id,c,'archive',request)).body.changed,false);assert.equal(h.testStore.shared.archiveEvents.size,1);
 const newer=await login(h);assert.equal((await action(h,r.id,newer,'archive')).body.changed,false);assert.equal(h.testStore.shared.archiveEvents.size,2);
 assert.equal((await action(h,r.id,newer,'restore')).body.changed,true);assert.equal((await action(h,r.id,newer,'restore')).body.changed,false);
 assert.equal((await action(h,r.id,newer,'archive',request)).body.archived,false);assert.equal((await h.testStore.adminArchiveState(r.id)).archived_at,null);
 const events=[...h.testStore.shared.archiveEvents.values()];assert.notEqual(events[0].actor_id,events[2].actor_id);assert.equal(events[2].action,'restore');
 assert.deepEqual(h.records(),before);assert.equal(await h.testStore.reservationOwner(r.id),owner);assert.equal(h.testStore.shared.claims.size,1);assert.equal(h.state.creates.length,0);assert.equal(h.state.payments.calls.length,0);assert.equal(h.state.refunds?.calls?.length || 0,0);
 const restarted=await harness(t,{},'[]',require('./helpers/memory-storage.cjs').memoryStore([],h.testStore.shared));assert.equal((await restarted.testStore.get(r.id)).dispatch.driver,'Original chauffeur');assert.equal(restarted.testStore.shared.archiveEvents.size,4);
});

test('default dispatch excludes archived; Archived Trips search/pagination and cursor binding preserve all other filters',async t=>{
 const a=record({paymentStatus:'unpaid'}),b=record(),active=record({status:'confirmed',paymentStatus:'unpaid'}),h=await harness(t,{},JSON.stringify([a,b,active])),c=await login(h);
 await action(h,a.id,c);await action(h,b.id,c);
 const query=(text)=>h.request('/api/bookings/search?'+text,undefined,{cookie:c});
 assert.deepEqual((await query('')).body.bookings.map(x=>x.id),[active.id]);assert.equal((await query('status=all&timing=all')).body.bookings.length,1);
 const first=await query('view=archived&status=all&timing=all&limit=1');assert.equal(first.status,200);assert.equal(first.body.bookings.length,1);assert.equal(first.body.bookings[0].archived,true);assert.ok(first.body.nextCursor);
 const next=await query('view=archived&status=all&timing=all&limit=1&cursor='+first.body.nextCursor);assert.equal(next.body.bookings.length,1);assert.notEqual(next.body.bookings[0].id,first.body.bookings[0].id);assert.equal(next.body.nextCursor,null);
 assert.equal((await query('view=dispatch&status=all&timing=all&limit=1&cursor='+first.body.nextCursor)).status,400);
 assert.deepEqual((await query('view=archived&status=all&timing=all&search='+a.id+'&payment=unpaid&vehicle=suv&airport=ewr')).body.bookings.map(x=>x.id),[a.id]);
 assert.equal((await query('view=archived&status=all&timing=all&search=%25')).body.bookings.length,0);
 assert.match(searchSql(adminQuery({},now)).text,/archived_at IS NULL/);assert.match(searchSql(adminQuery({view:'archived'},now)).text,/archived_at IS NOT NULL/);
});

test('future active, ongoing, hourly and return-leg safety are checked on current server state, with restore required for reactivation',async t=>{
 for(const status of ['awaiting_payment','confirmed','assigned','driver_en_route','passenger_on_board']){
  const r=record({status}),h=await harness(t,{},JSON.stringify([r])),c=await login(h);assert.equal((await action(h,r.id,c)).status,409);assert.equal(h.testStore.shared.archiveEvents.size,0);assert.deepEqual(h.records()[0],r);
 }
 assert.equal(canArchive({status:'confirmed'},'2026-10-01T16:00:00Z',now),true);assert.equal(canArchive({status:'confirmed'},null,now),false);
 for(const status of ['assigned','driver_en_route','passenger_on_board'])assert.equal(canArchive({status},'2026-09-01T00:00:00Z',now),false);
 for(const extra of [{tripType:'roundtrip',date:'2026-09-30',returnDate:'2026-10-02',returnTime:'12:00'},{tripType:'hourly',date:'2026-10-01',time:'11:00',hours:3}]){
  const r=record({status:'confirmed'});Object.assign(r.trip,extra);const h=await harness(t,{},JSON.stringify([r]));assert.equal((await action(h,r.id,await login(h))).status,409);
 }
 const r=record(),h=await harness(t,{},JSON.stringify([r])),c=await login(h);assert.equal((await action(h,r.id,c)).status,200);
 assert.equal((await h.request('/api/bookings/'+r.id,{status:'confirmed'},{...headers,cookie:c},'PATCH')).status,409);assert.equal(h.records()[0].status,'completed');
 await action(h,r.id,c,'restore');assert.equal((await h.request('/api/bookings/'+r.id,{status:'confirmed'},{...headers,cookie:c},'PATCH')).status,200);
});

test('archive errors roll back visibility/audit and authorization is revalidated after asynchronous lookup',async t=>{
 const r=record(),h=await harness(t,{},JSON.stringify([r])),c=await login(h);h.storageFailures.write=true;
 assert.equal((await action(h,r.id,c)).status,503);assert.equal(h.testStore.shared.adminArchives.size,0);assert.equal(h.testStore.shared.archiveEvents.size,0);h.storageFailures.write=false;
 const original=h.testStore.manageAdminArchive;h.testStore.manageAdminArchive=async(...args)=>{await h.request('/api/admin/logout',{},{cookie:c});return original(...args);};
 assert.equal((await action(h,r.id,c)).status,401);assert.equal(h.testStore.shared.archiveEvents.size,0);
});

test('archived historical unpaid trip stays owner-visible and payable; foreign accounts remain denied',async t=>{
 const h=await harness(t),owner=await h.request('/api/customer/register',{fullName:'Archive Owner',email:'archive-owner@example.test',phone:'2025550166',password:'Synthetic archive account password'}),other=await h.request('/api/customer/register',{fullName:'Other Owner',email:'other-archive@example.test',phone:'2035550166',password:'Synthetic archive account password'});
 const r=record({status:'awaiting_payment',paymentStatus:'unpaid',stripeSessionId:null});r.trip.date='2026-09-20';h.testStore.fixtures([r]);const id=[...h.testStore.shared.customers.values()].find(c=>c.normalized_email==='archive-owner@example.test').id;
 h.testStore.shared.tripRows.set(r.id,{customer_id:id,start:'2026-09-20T16:00:00Z',end:'2026-09-20T16:00:00Z'});
 assert.equal((await action(h,r.id,await login(h))).status,200);assert.equal(h.state.creates.length,0);
 assert.equal((await h.request('/api/customer/trips/'+r.id,undefined,{cookie:cookie(owner)})).status,200);
 assert.equal((await h.request('/api/customer/trips/'+r.id+'/payment',{}, {...headers,cookie:cookie(other)})).status,404);
 const payment=await h.request('/api/customer/trips/'+r.id+'/payment',{}, {...headers,cookie:cookie(owner)});assert.equal(payment.status,200);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,15000);
 const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session)).status,200);assert.equal(h.records()[0].paymentStatus,'paid');assert.ok((await h.testStore.adminArchiveState(r.id)).archived_at);
});

test('PostgreSQL archives: migration, atomic audit/visibility, concurrent workers, restart, rollback, relational ownership and untouched payment data',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:url.toString()}),schema='archive_test_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema}),pool2=new Pool({connectionString:url.toString(),options:'-c search_path='+schema}),{createStore}=require('../storage/postgres'),store=createStore({},pool),other=createStore({},pool2);
 t.after(async()=>{await store.close();await other.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await store.migrate();
 const customerId=crypto.randomUUID(),hash=crypto.randomBytes(32).toString('hex');await store.registerCustomer({id:customerId,full_name:'Archive Owner',normalized_email:'pg-archive@example.test',display_email:'pg-archive@example.test',normalized_phone:'+12025550176',display_phone:'2025550176',password_hash:'synthetic-test-hash'},{hash,created:new Date(now),expires:new Date(now+86400000)});
 const r=record(),active=record({status:'confirmed'});await store.createWithBudget(r,()=>{},{customerId,sessionHash:hash,now,start:new Date('2026-10-02T16:00:00Z'),end:new Date('2026-10-02T16:00:00Z')});await store.createWithBudget(active,()=>{});
 const before=(await pool.query('SELECT id,record,customer_id,scheduled_start_at,scheduled_end_at,version,updated_at FROM er_reservations ORDER BY id')).rows,ledger=(await pool.query('SELECT * FROM er_payment_ledger ORDER BY booking_id')).rows;
 const auth={actorId:crypto.randomUUID(),authorized:()=>true},key='reservation:'+r.id,req=input(),manage=(s,kind='archive',body=req)=>s.withActionLock(key,()=>s.manageAdminArchive(auth,r.id,body,kind,now));
 const results=await Promise.allSettled([manage(store),manage(other)]);assert.ok(results.some(x=>x.status==='fulfilled'));assert.equal((await manage(other)).changed,false);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM er_admin_trip_archive_events')).rows[0].n,1);
 await other.migrate();assert.ok((await other.adminArchiveState(r.id)).archived_at);assert.deepEqual((await store.searchAdminReservations(adminQuery({status:'all',timing:'all'},now))).bookings.map(x=>x.id),[active.id]);
 assert.deepEqual((await other.searchAdminReservations(adminQuery({view:'archived',status:'all',timing:'all',search:r.id},now))).bookings.map(x=>x.id),[r.id]);assert.deepEqual(await store.get(r.id),r);
 assert.deepEqual(await other.customerReservation(customerId,r.id),r);assert.equal(await other.customerReservation(crypto.randomUUID(),r.id),null);
 assert.deepEqual((await pool.query('SELECT id,record,customer_id,scheduled_start_at,scheduled_end_at,version,updated_at FROM er_reservations ORDER BY id')).rows,before);assert.deepEqual((await pool.query('SELECT * FROM er_payment_ledger ORDER BY booking_id')).rows,ledger);
 await assert.rejects(pool.query('UPDATE er_admin_trip_archive_events SET actor_id=$1',[crypto.randomUUID()]));await assert.rejects(pool.query('DELETE FROM er_admin_trip_archive_events'));
 assert.equal((await manage(other,'restore',input())).archived,false);assert.equal((await manage(store)).archived,false);
 await assert.rejects(store.withActionLock('reservation:'+active.id,()=>store.manageAdminArchive(auth,active.id,input(),'archive',now)),e=>e.status===409);
 for(let i=0;i<3;i++){const extra=record();await store.createWithBudget(extra,()=>{});await store.withActionLock('reservation:'+extra.id,()=>store.manageAdminArchive(auth,extra.id,input(),'archive',now));}
 const collected=[];let cursor;do{const result=await store.searchAdminReservations(adminQuery({view:'archived',status:'all',timing:'all',limit:'1',...(cursor?{cursor}:{})},now));collected.push(...result.bookings.map(x=>x.id));cursor=result.nextCursor;}while(cursor);assert.equal(collected.length,3);assert.equal(new Set(collected).size,3);
 await pool.query("CREATE FUNCTION er_archive_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic archive audit failure'; END $$");await pool.query('CREATE TRIGGER er_archive_test_failure BEFORE INSERT ON er_admin_trip_archive_events FOR EACH ROW EXECUTE FUNCTION er_archive_test_failure()');
 await assert.rejects(manage(store,'archive',input()),e=>e.storageFailure===true);assert.equal((await store.adminArchiveState(r.id)).archived_at,null);
});

function ui(){
 const p=path.join(__dirname,'admin-reservation-search.test.cjs'),s=fs.readFileSync(p,'utf8');
 const factory=new Function('require','__dirname',s.slice(0,s.indexOf("test('admin search"))+s.slice(s.indexOf('function ui(){'),s.indexOf("test('dispatch UI defaults"))+'\nreturn {ui};')(createRequire(p),__dirname);
 const h=factory.ui();h.context.crypto=crypto;return h;
}
test('archive UI needs a separate confirmation, blocks double-submit, preserves retry UUID and resets Archived Trips filters',async()=>{
 const h=ui();await new Promise(r=>setImmediate(r));h.elements.filterView.value='archived';h.events['filterView:change']();await new Promise(r=>setImmediate(r));assert.equal(h.elements.filterTiming.value,'all');assert.equal(h.elements.filterStatus.value,'all');assert.match(h.requests.at(-1).url,/view=archived/);
 h.events['clearFilters:click']();await new Promise(r=>setImmediate(r));assert.equal(h.elements.filterView.value,'dispatch');assert.equal(h.elements.filterTiming.value,'upcoming');assert.equal(h.elements.filterStatus.value,'active');
 const nodes={},card={dataset:{id:crypto.randomUUID(),archived:'false'},isConnected:true,querySelector:s=>nodes[s]};
 for(const cls of ['archiveBtn','confirmArchiveBtn','cancelArchiveBtn'])nodes['.'+cls]={disabled:false,hidden:false,focus(){},classList:{contains:c=>c===cls},closest:()=>card};nodes['.archive-confirmation']={hidden:true};
 const click=cls=>h.events['bookings:click']({target:nodes['.'+cls]});const before=h.requests.length;
 await click('archiveBtn');assert.equal(nodes['.archive-confirmation'].hidden,false);assert.equal(h.requests.length,before);
 await click('cancelArchiveBtn');assert.equal(nodes['.archive-confirmation'].hidden,true);assert.equal(h.requests.length,before);
 const original=h.context.fetch,calls=[];let resolve;h.context.fetch=async(url,options)=>{if(url.endsWith('/archive')){calls.push({url,options});return await new Promise(r=>resolve=r);}return original(url,options);};
 await click('archiveBtn');const pending=click('confirmArchiveBtn');await click('confirmArchiveBtn');assert.equal(calls.length,1);const request=JSON.parse(calls[0].options.body);assert.deepEqual(Object.keys(request).sort(),['confirmed','requestId']);assert.equal(request.confirmed,true);
 resolve({ok:false,status:503,json:async()=>({error:'Temporarily unavailable'})});await pending;const retry=click('confirmArchiveBtn');assert.equal(JSON.parse(calls[1].options.body).requestId,request.requestId);resolve({ok:true,json:async()=>({changed:true,archived:true})});await retry;assert.match(h.elements.notice.textContent,/Trip archived/);
});
test('stale archive responses cannot restore private DOM after logout/pagehide',async()=>{
 const h=ui();await new Promise(r=>setImmediate(r));const nodes={},card={dataset:{id:crypto.randomUUID(),archived:'true'},isConnected:true,querySelector:s=>nodes[s]};
 for(const cls of ['confirmArchiveBtn','cancelArchiveBtn'])nodes['.'+cls]={disabled:false,classList:{contains:c=>c===cls},closest:()=>card};let resolve;h.context.fetch=async()=>await new Promise(r=>resolve=r);
 const pending=h.events['bookings:click']({target:nodes['.confirmArchiveBtn']});h.events['window:pagehide']();resolve({ok:true,json:async()=>({changed:true,archived:false})});await pending;assert.equal(h.elements.bookings.innerHTML,'');assert.doesNotMatch(h.elements.notice.textContent,/Trip restored/);
});
