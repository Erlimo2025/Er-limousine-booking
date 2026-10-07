const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{createRequire}=require('node:module'),{Pool}=require('pg');
const {adminQuery,searchSql,adminDto,adminReservationStorage,page}=require('../storage/admin-reservations');
const {createStore}=require('../storage/postgres');
const harnessPath=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(harnessPath,'utf8');
const {harness}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness};')(createRequire(harnessPath),__dirname);
const at=Date.parse('2026-10-01T16:00:00Z');
const fixture=(extra={})=>({id:crypto.randomUUID(),createdAt:'2026-10-01T10:00:00Z',status:'awaiting_payment',paymentStatus:'unpaid',stripeSessionId:null,customer:{firstName:'Alice',lastName:'Smith',email:'alice@example.test',phone:'(201) 555-0199'},trip:{pickup:'Newark Liberty International Airport Terminal A',pickupPlaceId:'ChIJ2dQDPZNSwokRVJr9XE2SPt0',dropoff:'Times Square Manhattan',date:'2026-10-02',time:'12:00',vehicle:'suv',tripType:'oneway',passengers:2,flightNumber:'UA 123'},quote:{total:150,currency:'usd',vehicle:'Luxury SUV'},dispatch:{driver:'',driverPhone:'',vehicle:'',plate:''},...extra});
const cookie=r=>r.headers.getSetCookie()[0].split(';')[0];

test('admin search query strictly validates input/cursors and binds literal wildcard/injection searches',()=>{
 const defaults=adminQuery({},at);assert.equal(defaults.status,'active');assert.equal(defaults.timing,'upcoming');assert.equal(defaults.limit,25);
 for(const bad of [{status:'DROP TABLE'},{payment:'unknown'},{timing:'yesterday'},{airport:'ATL'},{vehicle:'sedan'},{limit:'100000'},{limit:['1','2']},{search:'x'.repeat(121)},{search:'x\nlog'},{search:['x']},{search:'one two three four five six seven'},{cursor:'broken'},{customer_id:'forged'}])assert.throws(()=>adminQuery(bad,at),e=>e.status===400);
 const q=adminQuery({search:"%' OR 1=1 --",status:'all',timing:'all'},at),sql=searchSql(q);assert.ok(!sql.text.includes(q.search));assert.ok(sql.values.some(x=>typeof x==='string'&&x.includes('\\%')));assert.ok(sql.values.includes(26));assert.match(sql.text,/LIMIT \$\d+/);assert.doesNotMatch(sql.text,/DELETE|UPDATE|INSERT/);
 assert.deepEqual(adminQuery({search:' +1 (201) 555-0199 '},at).terms,['2015550199']);assert.deepEqual(adminQuery({search:' Alice   SMITH '},at).terms,['alice','smith']);
 const r=fixture(),first=page([{record:r,id:r.id,start:'2026-10-02T16:00:00Z'},{record:fixture(),id:crypto.randomUUID(),start:'2026-10-03T16:00:00Z'}],adminQuery({limit:'1'},at));assert.ok(first.nextCursor);
 assert.ok(adminQuery({limit:'1',cursor:first.nextCursor},at).cursor);assert.throws(()=>adminQuery({limit:'1',status:'cancelled',cursor:first.nextCursor},at),e=>e.status===400);assert.throws(()=>adminQuery({limit:'1',cursor:first.nextCursor},at+86400001),e=>e.status===400);
});

test('admin search requires existing admin session, denies customers/guests and returns a minimal read-only projection',async t=>{
 const h=await harness(t),record=fixture();let calls=0;
 h.testStore.searchAdminReservations=async q=>{calls++;return page([{id:record.id,start:'2026-10-02T16:00:00Z',record}],q);};
 assert.equal((await h.request('/api/bookings/search')).status,401);assert.equal(calls,0);
 const customer=await h.request('/api/customer/register',{fullName:'Customer Account',email:'customer-search@example.test',phone:'2025550123',password:'Synthetic customer password'});assert.equal((await h.request('/api/bookings/search',undefined,{cookie:cookie(customer)})).status,401);assert.equal(calls,0);
 const admin=await h.request('/api/admin/login',{token:'local-test-token'}),c=cookie(admin),before=JSON.stringify(record);
 const r=await h.request('/api/bookings/search?search='+record.id,undefined,{cookie:c});assert.equal(r.status,200);assert.equal(r.body.bookings[0].id,record.id);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(calls,1);
 assert.equal((await h.request('/api/bookings/search?airport=forged',undefined,{cookie:c})).status,400);assert.equal(calls,1);assert.equal(JSON.stringify(record),before);
 const dto=adminDto({...record,customerAccess:{tokenHash:'private'},checkoutFingerprint:'private',stripeSessionId:'cs_private',customer_id:crypto.randomUUID()});assert.doesNotMatch(JSON.stringify(dto),/private|customer_id|tokenHash|stripeSessionId/);
 await h.request('/api/admin/logout',{},{cookie:c});assert.equal((await h.request('/api/bookings/search',undefined,{cookie:c})).status,401);
});

test('search storage enforces a short statement timeout and parameterized bounded SELECT',async()=>{
 const calls=[],r=fixture(),q=adminQuery({search:'Alice',airport:'ewr',payment:'unpaid'},at);
 const store=adminReservationStorage(null,async fn=>fn({query:async(text,values)=>{calls.push({text,values});return {rows:text.startsWith('WITH')?[{record:r,id:r.id,start:'2026-10-02T16:00:00Z'}]:[]};}}),x=>x);
 assert.equal((await store.searchAdminReservations(q)).bookings.length,1);assert.equal(calls[0].text,"SET LOCAL statement_timeout='5s'");assert.ok(calls[1].values.includes('%alice%'));assert.ok(calls[1].values.at(-1)<=51);assert.doesNotMatch(calls[1].text,/alice|DROP TABLE/);
});

function ui(){
 const elements={},events={},requests=[];
 const ids=['token','loadBtn','bookings','notice','adminLoginField','logoutBtn','reservationFilters','moreBookings','applyFilters','clearFilters','activeFilters','reservationSearch','filterStatus','filterPayment','filterTiming','filterAirport','filterVehicle'];
 for(const id of ids)elements[id]={value:'',innerHTML:'',textContent:'',disabled:false,hidden:true,options:[{textContent:id}],selectedIndex:0,classList:{toggle(){}},addEventListener:(event,fn)=>events[id+':'+event]=fn,insertAdjacentHTML(_,html){this.innerHTML+=html;}};
 const html=fs.readFileSync(path.join(__dirname,'../public/admin.html'),'utf8');
 for(const select of html.matchAll(/<select id="([^"]+)">([\s\S]*?)<\/select>/g)){
  const element=elements[select[1]];element.options=[...select[2].matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(option=>({value:option[1],textContent:option[2]}));
  let value=element.options[0].value;Object.defineProperty(element,'value',{get:()=>value,set:next=>{value=next;element.selectedIndex=element.options.findIndex(option=>option.value===next);}});
 }
 elements.reservationFilters.reset=()=>{elements.reservationSearch.value='';for(const key of ['Status','Payment','Timing','Airport','Vehicle'])elements['filter'+key].value=key==='Status'?'active':key==='Timing'?'upcoming':'all';};elements.reservationFilters.reset();
 const state={data:{bookings:[],nextCursor:null}};
 const context={document:{getElementById:id=>elements[id]},window:{addEventListener:(event,fn)=>events['window:'+event]=fn},URLSearchParams,fetch:async(url,options)=>{requests.push({url,options});return state.pending&&url.startsWith('/api/bookings/search')?await state.pending:{ok:true,json:async()=>url==='/api/admin/session'?{authenticated:true}:state.data};}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8'),context);return {context,elements,events,requests,state};
}
test('dispatch UI defaults upcoming, combines filters, paginates, clears filters and rejects stale results',async()=>{
 const h=ui();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.elements.reservationFilters.hidden,false);assert.match(h.requests.at(-1).url,/timing=upcoming/);assert.match(h.requests.at(-1).url,/status=active/);
 h.elements.filterTiming.value='tomorrow';h.elements.filterPayment.value='unpaid';h.elements.filterAirport.value='ewr';h.state.data={bookings:[adminDto(fixture())],nextCursor:'cursor'};
 await h.context.loadBookings();const last=h.requests.at(-1).url;for(const x of ['timing=tomorrow','payment=unpaid','airport=ewr'])assert.ok(last.includes(x));assert.equal(h.elements.moreBookings.hidden,false);assert.match(h.elements.bookings.innerHTML,/Save dispatch/);
 await h.context.loadBookings(true);assert.ok(h.requests.at(-1).url.includes('cursor=cursor'));assert.equal((h.elements.bookings.innerHTML.match(/booking-item/g)||[]).length,2);
 h.events['clearFilters:click']();await new Promise(resolve=>setImmediate(resolve));assert.match(h.requests.at(-1).url,/timing=upcoming/);assert.match(h.requests.at(-1).url,/payment=all/);assert.equal(h.elements.reservationSearch.value,'');
 let resolve;h.state.pending=new Promise(done=>resolve=done);const pending=h.context.loadBookings();h.events['window:pagehide']();resolve({ok:true,json:async()=>({bookings:[adminDto(fixture())],nextCursor:'private'})});await pending;assert.equal(h.elements.bookings.innerHTML,'');assert.equal(h.elements.moreBookings.hidden,true);
 const evil=fixture();evil.customer.firstName='<img onerror=alert(1)>';assert.ok(h.context.renderBooking(adminDto(evil)).includes('&lt;img'));assert.ok(!h.context.renderBooking(adminDto(evil)).includes('<img'));
});

test('dispatch Clear Filters explicitly resets every control, summary and pagination despite retained select state',async()=>{
 const h=ui();await new Promise(resolve=>setImmediate(resolve));
 h.elements.reservationSearch.value='Alice EWR';h.elements.filterPayment.value='unpaid';h.elements.filterAirport.value='ewr';h.elements.filterTiming.value='tomorrow';h.elements.filterStatus.value='cancelled';h.elements.filterVehicle.value='suv';
 h.state.data={bookings:[adminDto(fixture())],nextCursor:'filtered-page-cursor'};await h.context.loadBookings();await h.context.loadBookings(true);
 const filtered=new URL(h.requests.at(-1).url,'http://localhost').searchParams;assert.equal(filtered.get('payment'),'unpaid');assert.equal(filtered.get('airport'),'ewr');assert.equal(filtered.get('search'),'Alice EWR');assert.equal(filtered.get('cursor'),'filtered-page-cursor');
 // Reproduce a browser reset that restores text/timing/status but retains two selects.
 h.elements.reservationFilters.reset=()=>{h.elements.reservationSearch.value='';h.elements.filterTiming.value='upcoming';h.elements.filterStatus.value='active';h.elements.filterVehicle.value='all';};
 let resolve;h.state.pending=new Promise(done=>{resolve=done;});const before=h.requests.length;h.events['clearFilters:click']();
 for(const [id,value]of Object.entries({reservationSearch:'',filterTiming:'upcoming',filterStatus:'active',filterPayment:'all',filterAirport:'all',filterVehicle:'all'}))assert.equal(h.elements[id].value,value,id);
 assert.equal(h.elements.activeFilters.textContent,'Filters: Active / confirmed · All payment states · Upcoming · All airports / routes · All vehicles');
 assert.equal(h.elements.bookings.innerHTML,'');assert.equal(h.elements.moreBookings.hidden,true);assert.equal(h.requests.length,before+1);
 const defaults=new URL(h.requests.at(-1).url,'http://localhost').searchParams;
 assert.deepEqual(Object.fromEntries(defaults),{search:'',limit:'25',status:'active',payment:'all',timing:'upcoming',airport:'all',vehicle:'all'});
 resolve({ok:true,json:async()=>({bookings:[adminDto(fixture())],nextCursor:null})});await new Promise(done=>setImmediate(done));assert.equal(h.elements.moreBookings.hidden,true);assert.equal((h.elements.bookings.innerHTML.match(/booking-item/g)||[]).length,1);
});

test('dispatch cards prioritize stored New York pickup fields, fare, vehicle, passengers and safe contact links',()=>{
 const h=ui(),r=fixture();const before=JSON.stringify(r),html=h.context.renderBooking(adminDto(r));
 assert.match(html,/PICKUP · NEW YORK TIME/);assert.match(html,/Fri, Oct 2, 2026/);assert.match(html,/12:00 PM/);assert.match(html,/datetime="2026-10-02"/);assert.match(html,/datetime="12:00"/);
 assert.match(html,/href="tel:\+12015550199"/);assert.match(html,/href="mailto:alice%40example.test"/);assert.match(html,/Luxury SUV \/ Suburban/);assert.match(html,/<dt>Passengers<\/dt><dd>2<\/dd>/);assert.match(html,/\$150.00/);assert.match(html,/One way/);assert.match(html,new RegExp(r.id));
 assert.ok(html.indexOf('dispatch-pickup-time')<html.indexOf('dispatch-statuses'));assert.ok(html.indexOf('dispatch-statuses')<html.indexOf('dispatch-route'));assert.equal(JSON.stringify(r),before);
 r.trip.time='00:05';assert.match(h.context.renderBooking(adminDto(r)),/12:05 AM/);r.trip.time='23:45';assert.match(h.context.renderBooking(adminDto(r)),/11:45 PM/);
});

test('dispatch payment/reservation badges use only server states and cancelled cards are unmistakable',()=>{
 const h=ui(),html=r=>h.context.renderBooking(adminDto(r));
 assert.match(html(fixture()),/badge-unpaid[^>]*>UNPAID/);assert.match(html(fixture({paymentStatus:'paid',status:'confirmed'})),/badge-paid[^>]*>PAID/);
 const pending=fixture({checkoutAttempt:{state:'session_identified',evidence:'verified_paid_awaiting_webhook'}}),pendingHtml=html(pending);assert.match(pendingHtml,/PAYMENT PROCESSING/);assert.doesNotMatch(pendingHtml,/>PAID<|>UNPAID</);
 assert.match(html(fixture({checkoutAttempt:{state:'submitted_unknown'}})),/PAYMENT PROCESSING/);assert.match(html(fixture({paymentReviewRequired:true})),/PAYMENT REVIEW/);
 for(const [state,label]of Object.entries({processing:'REFUND PROCESSING',confirmed:'REFUND CONFIRMED',review_required:'REFUND REVIEW',failed:'REFUND FAILED · REVIEW'})){const r=fixture({status:'cancelled',paymentStatus:'paid',refundStatus:state}),text=html(r);assert.ok(text.includes(label));assert.match(text,/dispatch-card-cancelled/);assert.match(text,/CANCELLED — DO NOT DISPATCH/);assert.doesNotMatch(text,/>Confirmed</);}
 assert.match(html(fixture({status:'completed'})),/dispatch-card-completed/);assert.match(html(fixture({status:'cancelled'})),/>Cancelled</);
});

test('admin airport display prefers maintained EWR identities; JFK/LGA/legacy terminal labels are read-only',()=>{
 const h=ui();for(const [id,terminal]of Object.entries({'ChIJ2dQDPZNSwokRVJr9XE2SPt0':'Terminal A','ChIJ-6uTxfZSwokR-VfW-WSM53k':'Terminal B','ChIJMYEleJSwokRawcDBeH8NVg':'Terminal C'})){
  const r=fixture();r.trip.pickupPlaceId=id;r.trip.pickup='Newark Liberty International Airport Terminal B';const before=JSON.stringify(r),dto=adminDto(r);assert.deepEqual(dto.trip.pickupAirport,{code:'EWR',terminal});assert.ok(h.context.renderBooking(dto).includes('EWR • '+terminal.toUpperCase()));assert.equal(JSON.stringify(r),before);assert.ok(!JSON.stringify(dto).includes(id));
 }
 const general=fixture();general.trip.pickupPlaceId='ChIJ7wzsxeFSwokRhvLXxTe087M';assert.deepEqual(adminDto(general).trip.pickupAirport,{code:'EWR',terminal:null});
 for(const [pickup,airport,terminal]of [['John F. Kennedy International Airport Terminal 4, Queens, NY','JFK','Terminal 4'],['LaGuardia Airport Terminal B, Queens, NY','LGA','Terminal B']]){const r=fixture();delete r.trip.pickupPlaceId;r.trip.pickup=pickup;const dto=adminDto(r);assert.deepEqual(dto.trip.pickupAirport,{code:airport,terminal});assert.ok(h.context.renderBooking(dto).includes(airport+' • '+terminal.toUpperCase()));}
 const r=fixture();delete r.trip.pickupPlaceId;r.trip.pickup='JFK hotel';r.trip.dropoff='Home';assert.equal(adminDto(r).trip.pickupAirport,null);assert.doesNotMatch(h.context.renderBooking(adminDto(r)),/class="dispatch-airport"/);
 r.trip.pickup='Home';r.trip.dropoff='LaGuardia Airport Terminal C, Queens';assert.deepEqual(adminDto(r).trip.dropoffAirport,{code:'LGA',terminal:'Terminal C'});
});

test('dispatch collapses repeated A/B/C terminal labels without changing stored addresses or IDs',()=>{
 const h=ui();for(const terminal of ['A','B','C']){const r=fixture();r.trip.pickup=`Terminal ${terminal}, Terminal ${terminal}, 3 Brewster Rd`;r.trip.dropoff=`Terminal ${terminal}, Terminal ${terminal}, Terminal ${terminal}, Newark`;const before=JSON.stringify(r),html=h.context.renderBooking(adminDto(r));assert.ok(html.includes(`Terminal ${terminal}, 3 Brewster Rd`));assert.ok(html.includes(`Terminal ${terminal}, Newark`));assert.ok(!html.includes(`Terminal ${terminal}, Terminal ${terminal}`));assert.equal(JSON.stringify(r),before);}
 const r=fixture();r.trip.pickup='Terminal A, Terminal B, Airport';assert.ok(h.context.renderBooking(adminDto(r)).includes(r.trip.pickup));
});

test('dispatch notes, flight/airline and contacts are escaped; long notes remain in expandable text',()=>{
 const h=ui(),r=fixture();r.trip.airline='United Airlines';r.trip.notes='Please meet at baggage claim.';let html=h.context.renderBooking(adminDto(r));assert.match(html,/UA 123/);assert.match(html,/United Airlines/);assert.match(html,/<details class="dispatch-notes">/);assert.match(html,/<summary>Customer notes/);
 const attack='<img src=x onerror=alert(1)>" & <script>unsafe()</script>';r.customer.firstName=attack;r.customer.lastName=attack;r.customer.phone='javascript:alert(1)';r.customer.email='bad@example.test\r\nBcc:other@example.test';r.trip.pickup=attack;r.trip.dropoff=attack;r.trip.flightNumber=attack;r.trip.airline=attack;r.trip.notes=(attack+'\n').repeat(20);r.dispatch.driver=attack;
 html=h.context.renderBooking(adminDto(r));assert.ok(!html.includes('<img'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;img'));assert.doesNotMatch(html,/href="(?:javascript|tel:javascript|mailto:bad)/);assert.match(html,/dispatch-note-preview/);assert.match(html,/…/);assert.ok(html.includes('&lt;script&gt;unsafe()&lt;/script&gt;'));
 const bounded=adminDto(r);assert.ok(bounded.trip.notes.length<=2000);assert.ok(bounded.trip.airline.length<=120);assert.equal(r.trip.notes.length,(attack+'\n').length*20);
 const css=fs.readFileSync(path.join(__dirname,'../public/styles.css'),'utf8');assert.match(css,/\.dispatch-notes p\{[^}]*white-space:pre-wrap[^}]*overflow-wrap:anywhere[^}]*max-height:180px/);
});

test('dispatch editor preserves status/dispatch/reconciliation actions with accessible labels and compact mobile rules',()=>{
 const h=ui(),r=fixture({checkoutAttempt:{state:'review_required',quote:{promotion:{code:'FIRST15'}}}}),html=h.context.renderBooking(adminDto(r));assert.match(html,/<details class="dispatch-editor"><summary>Manage dispatch<\/summary>/);
 for(const cls of ['status','driver','driverPhone','vehicle','plate','saveBtn','reconcileBtn'])assert.ok(html.includes('class="'+cls+'"')||html.includes(' '+cls+'"'),cls);
 assert.match(html,/value="awaiting_payment" selected/);assert.match(html,/<label>Chauffeur<input/);assert.match(html,/Check FIRST15 payment state/);
 const editor=html.slice(html.indexOf('<details class="dispatch-editor">'),html.indexOf('</details>',html.indexOf('<details class="dispatch-editor">')));assert.ok(editor.includes('saveBtn'));assert.ok(editor.includes('reconcileBtn'));
 const css=fs.readFileSync(path.join(__dirname,'../public/styles.css'),'utf8');assert.match(css,/@media\(max-width:650px\)/);assert.match(css,/@media\(max-width:350px\)/);assert.match(css,/\.dispatch-route\{grid-template-columns:minmax\(0,1fr\)/);assert.match(css,/\.dispatch-editor input,[^}]*min-height:44px/);
});

test('PostgreSQL dispatch search: all fields, combined filters, NY dates/DST, legacy data, paging and no mutation',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const u=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(u.hostname));assert.ok(u.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:u.toString()}),schema='dispatch_test_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:u.toString(),options:'-c search_path='+schema}),store=createStore({},pool);t.after(async()=>{await store.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await store.migrate();
 const ewr=fixture(),jfk=fixture({status:'confirmed',paymentStatus:'paid'});ewr.trip.notes='Synthetic customer note';ewr.trip.airline='United Airlines';jfk.trip={...jfk.trip,date:'2026-10-01',pickup:'John F. Kennedy International Airport',pickupPlaceId:null,vehicle:'escalade'};
 const lga=fixture({status:'completed',paymentStatus:'paid'});lga.trip={...lga.trip,date:'2026-09-30',pickup:'LaGuardia Airport',pickupPlaceId:null};
 const other=fixture();other.trip={...other.trip,date:'2026-10-03',pickup:'JFK hotel',pickupPlaceId:null,dropoff:'Hotel Manhattan'};
 const cancelled=fixture({status:'cancelled'}),processing=fixture({checkoutAttempt:{key:crypto.randomUUID(),expiresAt:1790956800,quote:ewr.quote,state:'session_identified',evidence:'verified_paid_awaiting_webhook'}}),review=fixture({paymentReviewRequired:true}),refund=fixture({status:'cancelled',paymentStatus:'paid',refundStatus:'confirmed'});
 const overnight=fixture();overnight.trip={...overnight.trip,date:'2026-09-30',time:'23:00',tripType:'roundtrip',returnDate:'2026-10-02',returnTime:'12:00'};
 const legacy=fixture();legacy.trip={...legacy.trip,date:'2026-10-04'};
 const records=[ewr,jfk,lga,other,cancelled,processing,review,refund,overnight,legacy];
 for(const r of records)await pool.query('INSERT INTO er_reservations(id,record,created_at,scheduled_start_at,scheduled_end_at) VALUES($1,$2::jsonb,$3,CASE WHEN $4 THEN NULL ELSE ($5::timestamp AT TIME ZONE \'America/New_York\') END,CASE WHEN $4 THEN NULL ELSE ($6::timestamp AT TIME ZONE \'America/New_York\') END)',[r.id,JSON.stringify(r),r.createdAt,r===legacy,r.trip.date+' '+r.trip.time,(r.trip.returnDate || r.trip.date)+' '+(r.trip.returnTime || r.trip.time)]);
 const before=(await pool.query('SELECT id,record,customer_id,scheduled_start_at,scheduled_end_at FROM er_reservations ORDER BY id')).rows;
 const projected=(await store.searchAdminReservations(adminQuery({search:ewr.id,status:'all',timing:'all'},at))).bookings[0];assert.equal(projected.trip.notes,ewr.trip.notes);assert.equal(projected.trip.airline,ewr.trip.airline);assert.deepEqual(projected.trip.pickupAirport,{code:'EWR',terminal:'Terminal A'});assert.ok(!JSON.stringify(projected).includes(ewr.trip.pickupPlaceId));
 const ids=async input=>(await store.searchAdminReservations(adminQuery({status:'all',timing:'all',...input},at))).bookings.map(x=>x.id);
 for(const search of [ewr.id,' ALICE  smith ','ALICE@EXAMPLE.TEST','+1 (201) 555-0199','newark liberty','TIMES SQUARE','UA 123'])assert.ok((await ids({search})).includes(ewr.id),search);
 for(const search of ["' OR 1=1 --",'%','_','\\'])assert.deepEqual(await ids({search}),[]);
 assert.deepEqual((await ids({payment:'paid'})).sort(),[jfk.id,lga.id,refund.id].sort());assert.ok(!(await ids({payment:'unpaid'})).includes(processing.id));assert.ok(!(await ids({payment:'unpaid'})).includes(review.id));assert.ok((await ids({payment:'processing'})).includes(processing.id));assert.ok((await ids({payment:'review'})).includes(review.id));assert.deepEqual(await ids({payment:'refunded'}),[refund.id]);
 assert.deepEqual((await ids({status:'cancelled'})).sort(),[cancelled.id,refund.id].sort());assert.deepEqual(await ids({status:'completed'}),[lga.id]);assert.deepEqual(await ids({timing:'today'}),[jfk.id]);assert.ok((await ids({timing:'tomorrow'})).includes(ewr.id));assert.ok((await ids({timing:'upcoming'})).includes(overnight.id));assert.ok((await ids({timing:'upcoming'})).includes(legacy.id));assert.deepEqual((await ids({timing:'past'})).sort(),[jfk.id,lga.id].sort());
 assert.deepEqual(await ids({airport:'jfk'}),[jfk.id]);assert.deepEqual(await ids({airport:'lga'}),[lga.id]);assert.deepEqual(await ids({airport:'other'}),[other.id]);assert.ok((await ids({airport:'ewr'})).includes(ewr.id));assert.deepEqual(await ids({vehicle:'escalade'}),[jfk.id]);
 assert.deepEqual(await ids({timing:'tomorrow',payment:'unpaid',airport:'ewr',status:'active',search:ewr.id}),[ewr.id]);
 const collected=[];let cursor;do{const result=await store.searchAdminReservations(adminQuery({status:'all',timing:'all',limit:'2',...(cursor?{cursor}:{})},at));collected.push(...result.bookings.map(x=>x.id));cursor=result.nextCursor;}while(cursor);assert.equal(collected.length,records.length);assert.equal(new Set(collected).size,records.length);
 assert.deepEqual((await pool.query('SELECT id,record,customer_id,scheduled_start_at,scheduled_end_at FROM er_reservations ORDER BY id')).rows,before);
 const dst=fixture();dst.trip={...dst.trip,date:'2026-11-01',time:'01:30'};await pool.query('INSERT INTO er_reservations(id,record,created_at) VALUES($1,$2::jsonb,$3)',[dst.id,JSON.stringify(dst),dst.createdAt]);
 const now=Date.parse('2026-11-01T04:00:00Z');assert.ok((await store.searchAdminReservations(adminQuery({status:'all',timing:'today'},now))).bookings.some(x=>x.id===dst.id));assert.equal(adminQuery({},Date.parse('2026-10-02T02:00:00Z')).today,'2026-10-01');
});
