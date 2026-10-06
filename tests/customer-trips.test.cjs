const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module'),{Pool}=require('pg');
const {createStore}=require('../storage/postgres'),auth=require('../auth/customers');
const {tripQuery,tripDto,customerTripsStorage}=require('../storage/customer-trips');
const testPath=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(testPath,'utf8');
const {harness,booking}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(testPath),__dirname);
const account={fullName:'Account Owner',email:'owner@example.test',phone:'2025550188',password:'Synthetic account test passphrase'};
const accountCookie=r=>r.headers.getSetCookie().find(x=>x.includes('er_customer_session'))?.split(';')[0];
const bookCookies=(h,c)=>[h.checkoutCookies(),c].filter(Boolean).join('; ');
const register=(h,overrides={})=>h.request('/api/customer/register',{...account,...overrides});
function fixture(overrides={}){return {id:crypto.randomUUID(),createdAt:'2026-10-01T16:00:00.000Z',status:'awaiting_payment',paymentStatus:'unpaid',stripeSessionId:null,
 customer:{firstName:'Test',lastName:'Customer',email:'test@example.test',phone:'2015550199'},
 trip:{pickup:'A long pickup address',dropoff:'Destination',date:'2026-11-10',time:'12:00',vehicle:'escalade',tripType:'oneway',passengers:6},
 quote:{total:100,currency:'usd',vehicle:'Cadillac Escalade ESV',vehicleKey:'escalade'},dispatch:{driver:'',driverPhone:'',vehicle:'',plate:''},...overrides};}

test('My Trips SUV display uses Luxury SUV without changing stored vehicle, fare or other vehicle labels',()=>{
 const record=fixture();record.trip.vehicle='suv';record.quote.vehicleKey='suv';record.quote.vehicle='Black SUV';
 const original=JSON.stringify(record);
 assert.equal(tripDto(record).vehicle,'Luxury SUV');assert.equal(tripDto(record).total,record.quote.total);
 assert.equal(JSON.stringify(record),original);
 assert.equal(tripDto(fixture()).vehicle,'Cadillac Escalade ESV');
});

test('My Trips ownership derives only from a valid server session; cross-account and ID enumeration are denied',async t=>{
 const h=await harness(t),a=await register(h),b=await register(h,{email:'second@example.test',phone:'2035550188'});
 const aid=[...h.testStore.shared.customers.values()].find(x=>x.normalized_email===account.email).id;
 const out=await h.request('/api/checkout',{...booking,customer_id:'forged',customerId:'forged'},{cookie:accountCookie(a)});assert.equal(out.status,200);
 assert.equal(await h.testStore.reservationOwner(out.body.bookingId),aid);
 const own=await h.request('/api/customer/trips',undefined,{cookie:accountCookie(a)});assert.equal(own.body.trips[0].reference,out.body.bookingId);assert.match(own.headers.get('cache-control'),/no-store/);
 const detail=await h.request('/api/customer/trips/'+out.body.bookingId,undefined,{cookie:accountCookie(a)});assert.equal(detail.status,200);
 const wrong=await h.request('/api/customer/trips/'+out.body.bookingId,undefined,{cookie:accountCookie(b)}),missing=await h.request('/api/customer/trips/'+crypto.randomUUID(),undefined,{cookie:accountCookie(b)});
 assert.equal(wrong.status,404);assert.equal(missing.status,404);assert.equal(wrong.body.error,missing.body.error);
 assert.equal((await h.request('/api/customer/trips',undefined,{cookie:accountCookie(b)})).body.trips.length,0);
 const foreignCursor=Buffer.from(JSON.stringify({view:'upcoming',at:'2026-10-01T16:00:00.000Z',schedule:'2026-10-01T16:00:00.000Z',id:out.body.bookingId})).toString('base64url');
 assert.equal((await h.request('/api/customer/trips?cursor='+foreignCursor,undefined,{cookie:accountCookie(b)})).body.trips.length,0);
 assert.equal((await h.request('/api/customer/trips/'+out.body.bookingId)).status,401);
 assert.equal((await h.request('/api/booking/'+out.body.bookingId,undefined,{cookie:accountCookie(a)})).status,401);
 const combined=JSON.stringify(own.body)+JSON.stringify(detail.body);
 for(const secret of ['customerAccess','tokenHash','stripeSessionId','checkoutFingerprint','checkoutAttempt','dispatch','customer_id',aid,booking.email,booking.phone])assert.ok(!combined.includes(secret),secret);
 assert.deepEqual(Object.keys(detail.body.trip).sort(),['reference','status','paymentStatus','paymentVerificationPending','tripType','pickup','dropoff','date','time','timeZone','vehicle','passengers','pickupTerminal','dropoffTerminal','total','currency','createdAt'].sort());
});

test('guest email/phone matches and browser ownership fields never claim an account; guest retry stays guest',async t=>{
 const h=await harness(t),a=await register(h);
 const payload={...booking,email:account.email,phone:account.phone,customer_id:[...h.testStore.shared.customers.keys()][0]};
 const out=await h.request('/api/checkout',payload,{cookie:''});assert.equal(out.status,200);assert.equal(await h.testStore.reservationOwner(out.body.bookingId),null);
 assert.equal((await h.request('/api/customer/trips',undefined,{cookie:accountCookie(a)})).body.trips.length,0);
 const retry=await h.request('/api/checkout',payload,{cookie:bookCookies(h,accountCookie(a))});assert.equal(retry.status,200);assert.equal(h.state.creates.length,1);assert.equal(await h.testStore.reservationOwner(out.body.bookingId),null);
});

test('owned retry requires booking credential and never transfers ownership to another account',async t=>{
 const h=await harness(t),a=await register(h),b=await register(h,{email:'second@example.test',phone:'2035550188'});
 const out=await h.request('/api/checkout',booking,{cookie:accountCookie(a)}),owner=await h.testStore.reservationOwner(out.body.bookingId);
 assert.equal((await h.request('/api/checkout',booking,{cookie:accountCookie(a)})).status,503);
 assert.equal((await h.request('/api/checkout',booking,{cookie:bookCookies(h,accountCookie(b))})).status,503);
 assert.equal((await h.request('/api/checkout',booking,{cookie:bookCookies(h,accountCookie(a))})).status,200);
 assert.equal((await h.request('/api/checkout',booking,{cookie:h.checkoutCookies()})).status,200);
 assert.equal(await h.testStore.reservationOwner(out.body.bookingId),owner);assert.equal(h.state.creates.length,1);
 const session=[...h.state.sessions.values()][0];session.metadata.customer_id=[...h.testStore.shared.customers.keys()].find(id=>id!==owner);session.payment_status='paid';
 assert.equal((await h.webhook(session)).status,200);assert.equal((await h.webhook(session)).status,200);assert.equal(await h.testStore.reservationOwner(out.body.bookingId),owner);
 const trip=(await h.request('/api/customer/trips/'+out.body.bookingId,undefined,{cookie:accountCookie(a)})).body.trip;assert.equal(trip.status,'confirmed');assert.equal(trip.paymentStatus,'paid');
});

for(const kind of ['missing','malformed','wrong','duplicate','expired','revoked','disabled'])test('trip API rejects '+kind+' sessions; optional checkout remains guest',async t=>{
 const h=await harness(t),a=await register(h),raw=accountCookie(a),id=[...h.testStore.shared.customers.keys()][0];let cookie=raw;
 if(kind==='missing')cookie='';if(kind==='malformed')cookie='er_customer_session=malformed';if(kind==='wrong')cookie='er_customer_session='+'a'.repeat(43);if(kind==='duplicate')cookie=raw+'; '+raw;
 if(kind==='expired')h.advance(auth.SESSION_MS+1);
 if(kind==='revoked')await h.request('/api/customer/logout',{},{cookie:raw});
 if(kind==='disabled')h.testStore.shared.customers.get(id).account_status='disabled';
 assert.equal((await h.request('/api/customer/trips',undefined,{cookie})).status,401);
 const out=await h.request('/api/checkout',{...booking,date:'2027-02-10'},{cookie});assert.equal(out.status,200);assert.equal(await h.testStore.reservationOwner(out.body.bookingId),null);
 if(kind!=='missing')assert.match(out.headers.get('set-cookie'),/er_customer_session=;/);
});

test('schedule boundaries use authoritative New York parsing for all trip types and DST',async t=>{
 const h=await harness(t),a=await register(h);
 const cases=[
  [{...booking},'2026-11-10T17:00:00.000Z','2026-11-10T17:00:00.000Z'],
  [{...booking,tripType:'airport',time:'13:00'},'2026-11-10T18:00:00.000Z','2026-11-10T18:00:00.000Z'],
  [{...booking,tripType:'roundtrip',returnDate:'2026-11-11',returnTime:'16:00'},'2026-11-10T17:00:00.000Z','2026-11-11T21:00:00.000Z'],
  [{...booking,tripType:'hourly',hours:3},'2026-11-10T17:00:00.000Z','2026-11-10T20:00:00.000Z'],
  [{...booking,date:'2027-03-14',time:'03:30'},'2027-03-14T07:30:00.000Z','2027-03-14T07:30:00.000Z'],
  [{...booking,date:'2026-11-01',time:'01:30'},'2026-11-01T05:30:00.000Z','2026-11-01T05:30:00.000Z']
 ];
 for(const [body,start,end]of cases){const out=await h.request('/api/checkout',body,{cookie:bookCookies(h,accountCookie(a))});assert.equal(out.status,200);const row=h.testStore.shared.tripRows.get(out.body.bookingId);assert.equal(row.start,start);assert.equal(row.end,end);if(body.tripType==='hourly')assert.equal(h.records().find(r=>r.id===out.body.bookingId).quote.total,450);}
 assert.equal((await h.request('/api/checkout',{...booking,date:'2027-03-14',time:'02:30'},{cookie:accountCookie(a)})).status,400);
});

test('upcoming/past classification, terminal projection, keyset ties and strict cursor/limit validation',async t=>{
 const h=await harness(t),a=await register(h),owner=[...h.testStore.shared.customers.keys()][0],at=Date.parse('2026-10-01T16:00:00Z');
 const records=[];
 for(let i=0;i<55;i++){
  const r=fixture({status:i===0?'completed':i===1?'cancelled':'awaiting_payment'});records.push(r);
  h.testStore.shared.tripRows.set(r.id,{customer_id:owner,start:'2026-11-10T17:00:00.000Z',end:'2026-11-10T17:00:00.000Z'});
 }
 const round=fixture();round.trip={...round.trip,tripType:'roundtrip',returnDate:'2026-11-11',returnTime:'12:00',pickupPlaceId:'ChIJ2dQDPZNSwokRVJr9XE2SPt0',dropoffPlaceId:'ChIJMYEleJSwokRawcDBeH8NVg'};
 records.push(round);h.testStore.shared.tripRows.set(round.id,{customer_id:owner,start:'2026-09-30T17:00:00.000Z',end:'2026-11-11T17:00:00.000Z'});h.testStore.fixtures(records);
 const headers={cookie:accountCookie(a)},first=await h.request('/api/customer/trips',undefined,headers);assert.equal(first.body.trips.length,20);assert.ok(first.body.nextCursor);
 let ids=[],cursor=null;do{const r=await h.request('/api/customer/trips?limit=20'+(cursor?'&cursor='+cursor:''),undefined,headers);ids.push(...r.body.trips.map(x=>x.reference));cursor=r.body.nextCursor;}while(cursor);
 assert.equal(ids.length,54);assert.equal(new Set(ids).size,54);
 const max=await h.request('/api/customer/trips?limit=50',undefined,headers);assert.equal(max.body.trips.length,50);
 const past=await h.request('/api/customer/trips?view=past',undefined,headers);assert.equal(past.body.trips.length,2);assert.ok(past.body.trips.every(x=>['completed','cancelled'].includes(x.status)));
 const dto=(await h.request('/api/customer/trips/'+round.id,undefined,headers)).body.trip;assert.equal(dto.pickupTerminal,'Terminal A');assert.equal(dto.dropoffTerminal,'Terminal C');assert.equal(dto.returnDate,'2026-11-11');assert.equal(h.state.googleCalls,0);
 for(const query of ['limit=51','limit=0','limit=01','limit=1&limit=2','view=invalid','cursor=%%%','cursor='+Buffer.from('{}').toString('base64url'),'view=past&cursor='+first.body.nextCursor])assert.equal((await h.request('/api/customer/trips?'+query,undefined,headers)).status,400,query);
 h.advance(42*24*3600000);headers.cookie=accountCookie(await h.request('/api/customer/login',{email:account.email,password:account.password}));const later=await h.request('/api/customer/trips?view=past',undefined,headers);assert.equal(later.body.trips.length,20);assert.equal((await h.request('/api/customer/trips?cursor='+first.body.nextCursor,undefined,headers)).status,400);
 assert.throws(()=>tripQuery({cursor:Buffer.from(JSON.stringify({at:new Date(at+1).toISOString(),schedule:new Date(at).toISOString(),view:'upcoming',id:crypto.randomUUID()})).toString('base64url')},at));
});

test('approved terminal display is an own-property allowlist; no provider calls or fabricated luggage',()=>{
 for(const [id,label]of Object.entries(require('../ewr-pickups'))){const r=fixture();r.trip.pickupPlaceId=id;r.trip.dropoffPlaceId=id;assert.equal(tripDto(r).pickupTerminal,label.label);assert.equal(tripDto(r).dropoffTerminal,label.label);}
 const r=fixture();r.trip.pickupPlaceId='toString';r.trip.dropoffPlaceId='nearby-hotel';assert.equal(tripDto(r).pickupTerminal,null);assert.equal(tripDto(r).dropoffTerminal,null);assert.ok(!Object.hasOwn(tripDto(r),'luggage'));
});

test('trip query SQL scopes every access before decoding; failures remain fail closed',async()=>{
 const calls=[],pool={query:async(sql,args)=>{calls.push({sql,args});return {rows:[]};}},store=customerTripsStorage(pool,fn=>fn(),x=>x),id=crypto.randomUUID();
 await store.customerTrip(id,crypto.randomUUID());await store.customerTrips(id,tripQuery({},Date.now()));
 assert.match(calls[0].sql,/WHERE customer_id=\$1 AND id=\$2/);assert.match(calls[1].sql,/WHERE customer_id=\$1/);assert.equal(calls[0].args[0],id);assert.equal(calls[1].args[0],id);
});

test('schedule equality is Past, an unfinished return remains Upcoming, and the customer API abuse limit applies',async t=>{
 const h=await harness(t),a=await register(h),owner=[...h.testStore.shared.customers.keys()][0],r=fixture(),future=fixture();
 h.testStore.fixtures([r,future]);h.testStore.shared.tripRows.set(r.id,{customer_id:owner,start:'2026-10-01T16:00:00.000Z',end:'2026-10-01T16:00:00.000Z'});h.testStore.shared.tripRows.set(future.id,{customer_id:owner,start:'2026-09-30T16:00:00.000Z',end:'2026-10-02T16:00:00.000Z'});
 const headers={cookie:accountCookie(a)};assert.equal((await h.request('/api/customer/trips',undefined,headers)).body.trips[0].reference,future.id);assert.equal((await h.request('/api/customer/trips?view=past',undefined,headers)).body.trips[0].reference,r.id);
 let limited=false;for(let i=0;i<125;i++){const response=await h.request('/api/customer/trips',undefined,headers);if(response.status===429){limited=true;assert.equal(response.body.error,'Too many requests. Please try again later.');break;}}assert.ok(limited);
});

test('trip storage failures return generic reference-ID responses without internal data',async t=>{
 const h=await harness(t),a=await register(h);h.storageFailures.read=true;
 const r=await h.request('/api/customer/trips',undefined,{cookie:accountCookie(a)});assert.equal(r.status,503);assert.match(r.body.referenceId,/^[a-f0-9-]{36}$/);assert.doesNotMatch(JSON.stringify(r.body)+h.state.logs.join(''),/private-storage-marker|password_hash/);
});

function uiHarness(){
 const elements={},events={},state={tripResult:{trips:[],nextCursor:null},profile:true,requests:[]};
 const node=tag=>({tag,children:[],hidden:false,disabled:false,value:'',textContent:'',classList:{toggle(){},remove(){}},attributes:{},
  append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},get childElementCount(){return this.children.length;},
  setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,fn){events[this.id+':'+k]=fn;}});
 const html=fs.readFileSync(path.join(__dirname,'../public/account.html'),'utf8');for(const match of html.matchAll(/id="([^"]+)"/g)){elements[match[1]]=node('element');elements[match[1]].id=match[1];}
 for(const prefix of ['login','register']){const form=elements[prefix+'Form'];form.reset=()=>{};form.querySelector=selector=>selector==='button[type=submit]'?node('button'):elements[prefix+'Password'];}
 const context={document:{getElementById:id=>elements[id],querySelectorAll:()=>[],createElement:node},window:{addEventListener:(event,fn)=>{events['window:'+event]=fn;}},history:{replaceState(){}},location:{hash:''},setTimeout,
  fetch:async(url,options)=>{state.requests.push({url,options});if(url.endsWith('/profile')&&state.profilePending)return await state.profilePending;if(url.includes('/trips'))return state.pending?await state.pending:{ok:!state.error,status:state.error?503:200,json:async()=>state.error?{error:'Service temporarily unavailable.'}:state.tripResult};return {ok:state.profile || url.endsWith('/logout'),status:state.profile?200:401,json:async()=>url.endsWith('/logout')?{ok:true}:{customer:{fullName:'Test Customer',email:'synthetic@example.test',phone:'2015550188'}}};}};
 require('node:vm').createContext(context);require('node:vm').runInContext(fs.readFileSync(path.join(__dirname,'../public/account.js'),'utf8'),context);
 return {elements,events,state,context,node};
}
test('My Trips UI uses safe text nodes, wraps long addresses and displays read-only return/terminal details',()=>{
 const h=uiHarness(),r=fixture();r.trip.pickup='<img src=x onerror=alert(1)>'+('Very long address '.repeat(30));r.trip.tripType='roundtrip';r.trip.returnDate='2026-11-12';r.trip.returnTime='13:00';r.trip.pickupPlaceId='ChIJ2dQDPZNSwokRVJr9XE2SPt0';
 const card=h.context.tripCard(tripDto(r));const nodes=[];const walk=n=>{nodes.push(n);for(const child of n.children||[])walk(child);};walk(card);
 assert.ok(nodes.some(n=>n.textContent===r.trip.pickup+' → '+r.trip.dropoff));assert.ok(nodes.some(n=>n.textContent==='Terminal A'));assert.ok(nodes.some(n=>n.textContent.includes('2026-11-12')));assert.ok(!nodes.some(n=>['script','img','iframe'].includes(n.tag)));
 const source=fs.readFileSync(path.join(__dirname,'../public/account.js'),'utf8');assert.doesNotMatch(source,/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB/);
 assert.match(fs.readFileSync(path.join(__dirname,'../public/account.css'),'utf8'),/overflow-wrap:anywhere/);
});
test('My Trips UI loading, empty, error/retry and pagination states are explicit',async()=>{
 const h=uiHarness();h.elements.dashboardView.hidden=false;await h.context.loadTrips(false);assert.match(h.elements.tripsStatus.textContent,/Only rides booked while signed into this account/);assert.equal(h.elements.tripsBook.hidden,false);
 h.state.error=true;await h.context.loadTrips(false);assert.equal(h.elements.tripsRetry.hidden,false);assert.match(h.elements.tripsStatus.textContent,/temporarily unavailable/);
 h.state.error=false;h.state.tripResult={trips:[tripDto(fixture())],nextCursor:'synthetic-cursor'};await h.context.loadTrips(false);assert.equal(h.elements.tripsList.childElementCount,1);assert.equal(h.elements.tripsMore.hidden,false);
 h.state.tripResult={trips:[tripDto(fixture())],nextCursor:null};await h.context.loadTrips(true);assert.equal(h.elements.tripsList.childElementCount,2);assert.equal(h.elements.tripsMore.hidden,true);assert.ok(h.state.requests.at(-1).url.includes('cursor=synthetic-cursor'));
});
test('logout and browser restoration clear private DOM; delayed trip/profile responses cannot restore logged-out data',async()=>{
 const h=uiHarness();let resolve;h.state.pending=new Promise(r=>{resolve=r;});h.context.dashboard({fullName:'Private Name',email:'private@example.test',phone:'2015550188'});
 await h.context.logout();resolve({ok:true,status:200,json:async()=>({trips:[tripDto(fixture())],nextCursor:null})});await new Promise(r=>setImmediate(r));
 assert.equal(h.elements.tripsList.childElementCount,0);assert.equal(h.elements.profileName.textContent,'');assert.equal(h.elements.dashboardView.hidden,true);
 h.state.pending=null;h.context.dashboard({fullName:'Private Name',email:'private@example.test',phone:'2015550188'});await new Promise(r=>setImmediate(r));h.events['window:pagehide']();
 assert.equal(h.elements.profileName.textContent,'');assert.equal(h.elements.tripsList.childElementCount,0);assert.equal(h.elements.dashboardView.hidden,true);
 h.state.profile=false;await h.events['window:pageshow']();assert.equal(h.elements.loginView.hidden,false);assert.equal(h.elements.dashboardView.hidden,true);
 let profileResolve;h.state.profilePending=new Promise(r=>{profileResolve=r;});const loading=h.context.load();await h.context.logout();profileResolve({ok:true,status:200,json:async()=>({customer:{fullName:'Stale Customer',email:'private@example.test',phone:'2015550188'}})});await loading;assert.equal(h.elements.dashboardView.hidden,true);assert.equal(h.elements.profileName.textContent,'');
});

test('PostgreSQL My Trips: ownership, legacy migration, schedule indexes, immutable updates, session race, rollback and pagination',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const u=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(u.hostname));assert.ok(u.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:u.toString()}),schema='trips_test_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:u.toString(),options:'-c search_path='+schema}),pool2=new Pool({connectionString:u.toString(),options:'-c search_path='+schema});
 const store=createStore({},pool),other=createStore({},pool2);t.after(async()=>{await store.close();await other.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await store.migrate();const legacy=fixture();await store.importLegacy([legacy]);await Promise.all([store.migrate(),other.migrate()]);
 assert.equal((await pool.query('SELECT customer_id,record FROM er_reservations WHERE id=$1',[legacy.id])).rows[0].customer_id,null);assert.deepEqual((await store.get(legacy.id)),legacy);
 const h=await harness(t,{},'[]',store),a=await register(h),b=await register(h,{email:'second@example.test',phone:'2035550188'}),c=accountCookie(a),hash=auth.hashToken(c.split('=')[1]);
 const aid=(await pool.query('SELECT id FROM er_customers WHERE normalized_email=$1',[account.email])).rows[0].id,bid=(await pool.query('SELECT id FROM er_customers WHERE normalized_email=$1',['second@example.test'])).rows[0].id;
 const out=await h.request('/api/checkout',booking,{cookie:c});assert.equal(out.status,200);
 let row=(await pool.query('SELECT * FROM er_reservations WHERE id=$1',[out.body.bookingId])).rows[0];assert.equal(row.customer_id,aid);assert.equal(row.scheduled_end_at.toISOString(),'2026-11-10T17:00:00.000Z');assert.ok(!Object.hasOwn(row.record,'customer_id'));
 assert.equal((await h.request('/api/customer/trips/'+row.id,undefined,{cookie:accountCookie(b)})).status,404);
 await other.update(row.id,r=>{r.status='assigned';r.customer_id=bid;});assert.equal(await store.reservationOwner(row.id),aid);
 assert.equal((await h.request('/api/checkout',booking,{cookie:bookCookies(h,accountCookie(b))})).status,503);
 assert.equal((await h.request('/api/checkout',booking,{cookie:bookCookies(h,c)})).status,200);assert.equal(h.state.creates.length,1);
 const session=[...h.state.sessions.values()][0];session.payment_status='paid';session.metadata.customerId=bid;await h.webhook(session);await h.webhook(session);assert.equal(await store.reservationOwner(row.id),aid);
 assert.equal((await pool.query('SELECT count(*) FROM er_payment_ledger WHERE booking_id=$1',[row.id])).rows[0].count,'1');
 await assert.rejects(pool.query('DELETE FROM er_customers WHERE id=$1',[aid]),/foreign key/);
 const association={customerId:aid,sessionHash:hash,now:Date.parse('2026-10-01T16:00:00Z'),start:new Date('2026-11-10T17:00:00Z'),end:new Date('2026-11-10T17:00:00Z')};
 const stale=fixture();await store.revokeCustomerSession(hash);await store.createWithBudget(stale,()=>{},association);assert.equal(await store.reservationOwner(stale.id),null);
 const login=await h.request('/api/customer/login',{email:account.email,password:account.password});association.sessionHash=auth.hashToken(accountCookie(login).split('=')[1]);
 const fixtureRows=[];for(let i=0;i<23;i++){const f=fixture();fixtureRows.push(f);await store.createWithBudget(f,()=>{},association);}
 const page=await store.customerTrips(aid,tripQuery({limit:'20'},association.now));assert.equal(page.trips.length,20);assert.ok(page.nextCursor);
 const page2=await other.customerTrips(aid,tripQuery({limit:'20',cursor:page.nextCursor},association.now));assert.equal(page2.trips.length,4);assert.equal(new Set([...page.trips,...page2.trips].map(x=>x.reference)).size,24);
 assert.equal(await store.customerTrip(bid,fixtureRows[0].id),null);
 const failing=fixture();await pool.query("CREATE FUNCTION reject_trip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private failure'; END $$");await pool.query('CREATE TRIGGER reject_trip BEFORE INSERT ON er_reservations FOR EACH ROW EXECUTE FUNCTION reject_trip()');
 await assert.rejects(store.createWithBudget(failing,()=>{},association),e=>e.storageFailure);assert.equal(await store.get(failing.id),null);await pool.query('DROP TRIGGER reject_trip ON er_reservations');
 const lock=await pool2.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM er_customers WHERE id=$1 FOR UPDATE',[aid]);
 const racing=fixture(),creating=store.createWithBudget(racing,()=>{},association);await lock.query('DELETE FROM er_customer_sessions WHERE customer_id=$1',[aid]);await lock.query('COMMIT');lock.release();await creating;assert.equal(await store.reservationOwner(racing.id),null);
 await Promise.all([store.migrate(),other.migrate()]);assert.equal(await store.reservationOwner(row.id),aid);assert.equal(await store.reservationOwner(legacy.id),null);
});

test('My Trips renders payment action for unpaid only and scopes full payment record lookup in SQL',async()=>{
 const {tripDto}=require('../storage/customer-trips');
 const src=fs.readFileSync(path.join(__dirname,'../public/account.js'),'utf8');
 const start=src.indexOf('function tripCard('),end=src.indexOf('async function loadTrips',start);
 const node=tag=>({tag,children:[],textContent:'',append(...x){this.children.push(...x)},addEventListener(){},setAttribute(){}});
 const ctx={document:{createElement:node},Intl};require('node:vm').createContext(ctx);require('node:vm').runInContext(src.slice(start,end),ctx);
 const walk=n=>[n,...n.children.flatMap(walk)];
 const r=fixture();assert.ok(walk(ctx.tripCard(tripDto(r))).some(x=>x.tag==='button'&&x.textContent==='Complete Payment'));
 r.paymentStatus='paid';assert.ok(!walk(ctx.tripCard(tripDto(r))).some(x=>x.textContent==='Complete Payment'));
 const calls=[],store=customerTripsStorage({query:async(sql,args)=>{calls.push({sql,args});return {rows:[]};}},fn=>fn(),x=>x);
 const owner=crypto.randomUUID();await store.customerReservation(owner,crypto.randomUUID());assert.match(calls[0].sql,/WHERE customer_id=\$1 AND id=\$2/);assert.equal(calls[0].args[0],owner);
});

test('My Trips pending verification hides payment action without claiming Paid or trusting client flags',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../public/account.js'),'utf8'),start=src.indexOf('function tripCard('),end=src.indexOf('async function loadTrips',start);
 const node=tag=>({tag,children:[],textContent:'',append(...x){this.children.push(...x)},addEventListener(){},setAttribute(){}}),ctx={document:{createElement:node},Intl};
 require('node:vm').createContext(ctx);require('node:vm').runInContext(src.slice(start,end),ctx);const walk=n=>[n,...n.children.flatMap(walk)];
 const r=fixture();r.paymentVerificationPending=true;assert.equal(tripDto(r).paymentVerificationPending,false);
 r.checkoutAttempt={state:'session_identified',evidence:'verified_paid_awaiting_webhook'};const dto=tripDto(r);assert.equal(dto.paymentStatus,'unpaid');assert.equal(dto.paymentVerificationPending,true);
 let nodes=walk(ctx.tripCard(dto));assert.ok(!nodes.some(n=>n.textContent==='Complete Payment'));assert.ok(nodes.some(n=>/do not need to pay again/.test(n.textContent)));
 r.status='cancelled';nodes=walk(ctx.tripCard(tripDto(r)));assert.ok(!nodes.some(n=>n.textContent==='Complete Payment'));assert.ok(!nodes.some(n=>/do not need to pay again/.test(n.textContent)));
 r.status='confirmed';r.paymentStatus='paid';assert.equal(tripDto(r).paymentVerificationPending,false);assert.ok(!walk(ctx.tripCard(tripDto(r))).some(n=>n.textContent==='Complete Payment'));
});
