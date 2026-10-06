const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{createRequire}=require('node:module'),{Pool}=require('pg');
const harnessFile=path.join(__dirname,'security-abuse.test.cjs'),source=fs.readFileSync(harnessFile,'utf8');
const {harness,booking}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(harnessFile),__dirname);
const {reusableTrip,tripDto}=require('../storage/customer-trips');
const account={fullName:'Book Again Owner',email:'again@example.test',phone:'2025550191',password:'Synthetic book again password'};
const cookie=r=>r.headers.getSetCookie().find(x=>x.includes('er_customer_session')).split(';')[0];
const register=(h,extra={})=>h.request('/api/customer/register',{...account,...extra});
const templateUrl=id=>'/api/customer/trips/'+id+'/book-again';

test('Book Again is an owner-scoped read-only allowlist, with no old fare/date/payment/customer state',async t=>{
 const h=await harness(t),a=await register(h),b=await register(h,{email:'other-again@example.test',phone:'2025550192'}),auth={cookie:cookie(a)};
 const old=await h.request('/api/checkout',{...booking,paymentChoice:'later',pickupTerminal:'general',flightNumber:'OLD123',notes:'Old notes'},auth);
 const before=JSON.stringify(h.records()),r=await h.request(templateUrl(old.body.bookingId),undefined,auth);
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('referrer-policy'),'no-referrer');
 assert.deepEqual(Object.keys(r.body).sort(),['flowReference','template']);
 assert.deepEqual(Object.keys(r.body.template).sort(),['pickup','dropoff','pickupPlaceId','vehicle','passengers','tripType'].sort());
 assert.equal(r.body.template.vehicle,'escalade');assert.equal(r.body.template.pickupPlaceId,booking.pickupPlaceId);assert.equal(r.body.template.passengers,6);
 assert.notEqual(r.body.flowReference.slice(0,36),old.body.bookingId);assert.equal(JSON.stringify(h.records()),before);assert.equal(h.state.creates.length,0);
 for(const forbidden of ['date','time','returnDate','returnTime','total','discount','promoCode','offerCode','paymentStatus','stripeSessionId','customer','notes','flightNumber','id','reference'])assert.ok(!Object.hasOwn(r.body.template,forbidden),forbidden);
 const foreign=await h.request(templateUrl(old.body.bookingId),undefined,{cookie:cookie(b)}),missing=await h.request(templateUrl(crypto.randomUUID()),undefined,{cookie:cookie(b)});
 assert.equal(foreign.status,404);assert.equal(foreign.body.error,missing.body.error);assert.deepEqual(Object.keys(foreign.body).sort(),Object.keys(missing.body).sort());
 assert.equal((await h.request(templateUrl(old.body.bookingId))).status,401);
 assert.equal((await h.request(templateUrl(old.body.bookingId),undefined,{cookie:h.checkoutCookies()})).status,401);
 assert.equal((await h.request(templateUrl('forged'),undefined,auth)).status,404);
 assert.equal((await h.request('/api/customer/trips',undefined,auth)).body.trips[0].canBookAgain,true);
});

test('Book Again creates a fresh normally priced Pay Now/Pay Later reservation; same flow retries deduplicate',async t=>{
 for(const choice of ['now','later']){
  const h=await harness(t),a=await register(h),auth={cookie:cookie(a)},old=await h.request('/api/checkout',{...booking,paymentChoice:'later'},auth);
  await h.testStore.update(old.body.bookingId,r=>{r.quote.total=999;});
  const r=await h.request(templateUrl(old.body.bookingId),undefined,auth),body={...booking,...r.body.template,bookingFlow:r.body.flowReference,paymentChoice:choice,total:1,amount:1,paymentStatus:'paid',stripeSessionId:'cs_forged',id:old.body.bookingId};
  // Even manually selecting the exact same future schedule must not reuse the source.
  const fresh=await h.request('/api/checkout',body,auth);assert.equal(fresh.status,200);assert.notEqual(fresh.body.bookingId,old.body.bookingId);
  const stored=h.records().find(x=>x.id===fresh.body.bookingId);assert.equal(stored.quote.total,100);assert.equal(stored.paymentStatus,'unpaid');assert.equal(stored.status,'awaiting_payment');assert.equal(h.records().length,2);
  assert.ok(!JSON.stringify(stored).includes(r.body.flowReference));assert.equal(h.state.creates.length,choice==='now'?1:0);
  if(choice==='now')assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,10000);else assert.equal(stored.stripeSessionId,null);
  const retry=await h.request('/api/checkout',body,{cookie:h.checkoutCookies()+'; '+cookie(a)});assert.equal(retry.status,200);assert.equal(retry.body.bookingId,fresh.body.bookingId);assert.equal(h.records().length,2);assert.equal(h.state.creates.length,choice==='now'?1:0);
  const before=h.records().length;assert.equal((await h.request('/api/checkout',{...body,date:'',time:''},auth)).status,400);assert.equal(h.records().length,before);
 }
});

test('Book Again flow cannot be forged, used by guests or transferred to another session/account',async t=>{
 const h=await harness(t),a=await register(h),b=await register(h,{email:'second-again@example.test',phone:'2025550192'}),old=await h.request('/api/checkout',{...booking,paymentChoice:'later'},{cookie:cookie(a)});
 const r=await h.request(templateUrl(old.body.bookingId),undefined,{cookie:cookie(a)}),body={...booking,date:'2026-12-10',bookingFlow:r.body.flowReference,paymentChoice:'later'};
 for(const c of ['',cookie(b)])assert.equal((await h.request('/api/checkout',body,{cookie:c})).status,400);
 assert.equal((await h.request('/api/checkout',{...body,bookingFlow:crypto.randomUUID()+'.'+'0'.repeat(64)},{cookie:cookie(a)})).status,400);
 await h.request('/api/customer/logout',{},{cookie:cookie(a)});assert.equal((await h.request(templateUrl(old.body.bookingId),undefined,{cookie:cookie(a)})).status,401);assert.equal(h.records().length,1);
});

test('template preserves supported routes/vehicles/terminal identities only; invalid sources are not reusable',()=>{
 for(const tripType of ['oneway','airport','roundtrip','hourly'])for(const vehicle of ['suv','escalade']){
  const r={trip:{...booking,tripType,vehicle,hours:'3.5',dropoffPlaceId:'ChIJ-6uTxfZSwokR-VfW-WSM53k',returnDate:'2026-11-11',returnTime:'15:00'},quote:{total:150}};
  const before=JSON.stringify(r),t=reusableTrip(r);assert.equal(t.vehicle,vehicle);assert.equal(t.tripType,tripType);assert.equal(t.dropoffPlaceId,r.trip.dropoffPlaceId);assert.equal(Object.hasOwn(t,'hours'),tripType==='hourly');assert.equal(JSON.stringify(r),before);
 }
 for(const change of [{pickup:''},{dropoff:' '},{vehicle:'unknown'},{tripType:'unknown'},{passengers:0},{passengers:7},{passengers:'bad'},{tripType:'hourly',hours:9}])assert.equal(reusableTrip({trip:{...booking,...change}}),null);
});

function bookingUi(){
 const src=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),start=src.indexOf('let bookAgainGeneration='),end=src.indexOf('async function initialize()',start),events={},calls=[],fields={};
 const input=()=>({value:'old',dataset:{placeId:'old'},disabled:false,required:false,focus(){this.focused=true;}});
 for(const k of ['pickup','dropoff','vehicle','passengers','hours','dateInput','timeInput','returnDate','returnTime','promoCode','offerCode','quoteBtn'])fields[k]=input();
 const ctx={...fields,form:{reset(){for(const i of Object.values(fields))i.value='';}},URLSearchParams,window:{location:{search:'?bookAgain='+crypto.randomUUID(),pathname:'/',hash:'#book',assign(v){calls.push(['redirect',v]);}},history:{replaceState(...args){calls.push(['history',...args]);}},addEventListener(e,f){events[e]=f;}},
  clearSpecialOffer(){fields.offerCode.value='';},selectTripType(v){calls.push(['type',v]);fields.returnDate.required=fields.returnTime.required=v==='roundtrip';},resetPassengerOptions(){},syncPickupTerminal(){calls.push(['pickupTerminal']);},syncDropoffTerminal(){},updateHourlyRates(){},resetQuote(){calls.push(['reset']);},showBookingStep(v){calls.push(['step',v]);},showNotice(...v){calls.push(['notice',...v]);},fetch:async(url,options)=>{calls.push(['fetch',url,options]);return {ok:true,status:200,json:async()=>({template:{...booking},flowReference:crypto.randomUUID()+'.'+'a'.repeat(64)})};}};
 vm.createContext(ctx);vm.runInContext(src.slice(start,end),ctx);return {ctx,fields,calls,events};
}
test('booking prefill clears dates/coupons/old identity, returns to Step 1 and only requires normal fresh quoting',()=>{
 const h=bookingUi(),flow=crypto.randomUUID()+'.'+'a'.repeat(64),template={...booking,tripType:'roundtrip',vehicle:'suv',date:'2020-01-01',time:'09:00',total:1,stripeSessionId:'cs_old',id:'old',paymentStatus:'paid'};
 h.ctx.applyBookAgainTemplate(template,flow);
 assert.equal(h.fields.pickup.value,booking.pickup);assert.equal(h.fields.dropoff.value,booking.dropoff);assert.equal(h.fields.vehicle.value,'suv');assert.equal(h.fields.passengers.value,'6');assert.equal(h.fields.pickup.dataset.placeId,booking.pickupPlaceId);assert.equal(h.fields.dropoff.dataset.placeId,undefined);
 for(const name of ['dateInput','timeInput','returnDate','returnTime','promoCode','offerCode'])assert.equal(h.fields[name].value,'');
 assert.equal(h.fields.dateInput.required,true);assert.equal(h.fields.timeInput.required,true);assert.equal(h.fields.returnDate.required,true);assert.equal(h.fields.returnTime.required,true);assert.ok(h.fields.dateInput.focused);
 assert.ok(h.calls.some(x=>x[0]==='notice'&&x[1].includes('new pickup date and time')));assert.ok(h.calls.some(x=>x[0]==='step'&&x[1]===1));assert.ok(!h.calls.some(x=>x[0]==='fetch'));
 const src=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');assert.match(src,/await loadBookAgainTemplate\(\)/);assert.match(src,/if\(bookAgainFlowReference\)data\.bookingFlow=bookAgainFlowReference/);assert.doesNotMatch(src.slice(src.indexOf('let bookAgainGeneration='),src.indexOf('async function initialize()')),/localStorage|sessionStorage|\/api\/checkout|\/api\/quote/);
 assert.match(src,/delete input\.dataset\.placeId/); // Existing manual editing still clears trusted identities.
});
test('booking prefill fetches only authenticated server template and ignores stale responses or expired sessions',async()=>{
 const h=bookingUi();await h.ctx.loadBookAgainTemplate();assert.equal(h.calls.filter(x=>x[0]==='fetch').length,1);assert.equal(h.calls.find(x=>x[0]==='fetch')[2].cache,'no-store');assert.equal(h.calls.find(x=>x[0]==='history')[3],'/#book');
 const stale=bookingUi();let release;stale.ctx.fetch=()=>new Promise(r=>release=r);const pending=stale.ctx.loadBookAgainTemplate();stale.events.pagehide();release({ok:true,status:200,json:async()=>({template:booking,flowReference:crypto.randomUUID()+'.'+'a'.repeat(64)})});await pending;assert.equal(stale.fields.pickup.value,'old');assert.ok(!stale.calls.some(x=>x[0]==='notice'));
 const expired=bookingUi();expired.ctx.fetch=async()=>({ok:false,status:401});await expired.ctx.loadBookAgainTemplate();assert.ok(expired.calls.some(x=>x[0]==='redirect'&&x[1]==='/account.html'));assert.equal(expired.fields.pickup.value,'old');
});
test('bfcache restores unfinished Book Again fetch, keeps stale responses inert and unlocks fresh quoting',async()=>{
 const h=bookingUi(),releases=[];h.ctx.fetch=()=>new Promise(resolve=>releases.push(resolve));
 const old=h.ctx.loadBookAgainTemplate();assert.equal(h.fields.quoteBtn.disabled,true);
 h.ctx.window.location.search='';h.events.pagehide();h.events.pageshow({persisted:true});assert.equal(releases.length,2);
 const current={...booking,pickup:'New owned pickup',vehicle:'suv'},flow=crypto.randomUUID()+'.'+'b'.repeat(64);
 releases[1]({ok:true,status:200,json:async()=>({template:current,flowReference:flow})});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.fields.pickup.value,current.pickup);assert.equal(h.fields.vehicle.value,'suv');assert.equal(h.fields.quoteBtn.disabled,false);assert.equal(h.fields.dateInput.value,'');
 releases[0]({ok:true,status:200,json:async()=>({template:booking,flowReference:crypto.randomUUID()+'.'+'a'.repeat(64)})});await old;
 assert.equal(h.fields.pickup.value,current.pickup);assert.equal(h.fields.vehicle.value,'suv');assert.equal(h.fields.quoteBtn.disabled,false);
 h.events.pageshow({persisted:true});assert.equal(releases.length,2,'Completed template is not fetched repeatedly');
});
test('restored Book Again rejection leaves manual booking usable and clears the pending source',async()=>{
 const h=bookingUi();let release;h.ctx.fetch=()=>new Promise(resolve=>release=resolve);const old=h.ctx.loadBookAgainTemplate();
 h.ctx.window.location.search='';h.events.pagehide();release({ok:false,status:401});await old;assert.ok(!h.calls.some(x=>x[0]==='redirect'));
 let requests=0;h.ctx.fetch=async()=>{requests++;return {ok:false,status:404};};h.events.pageshow({persisted:true});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests,1);assert.equal(h.fields.quoteBtn.disabled,false);assert.ok(h.calls.some(x=>x[0]==='notice'&&x[1].includes('enter your trip details')));
 h.events.pageshow({persisted:true});assert.equal(requests,1,'Terminal failure must not keep restarting reads');
});
test('My Trips shows Book Again for reusable past/paid/unpaid trips, but hides it for incomplete data',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../public/account.js'),'utf8'),start=src.indexOf('function tripCard('),end=src.indexOf('async function loadTrips',start),node=tag=>({tag,children:[],append(...x){this.children.push(...x);},addEventListener(){}}),ctx={document:{createElement:node},Intl};vm.createContext(ctx);vm.runInContext(src.slice(start,end),ctx);
 const walk=n=>[n,...n.children.flatMap(walk)],r={id:crypto.randomUUID(),trip:booking,quote:{total:100,currency:'usd',vehicle:'Luxury SUV'},createdAt:'2026-10-01T16:00:00Z'};
 for(const [status,paymentStatus]of [['completed','paid'],['awaiting_payment','unpaid'],['cancelled','unpaid']]){r.status=status;r.paymentStatus=paymentStatus;const link=walk(ctx.tripCard(tripDto(r))).find(x=>x.textContent==='Book Again');assert.ok(link);assert.equal(link.href,'/?bookAgain='+r.id+'#book');}
 r.trip={...booking,pickup:''};assert.ok(!walk(ctx.tripCard(tripDto(r))).some(x=>x.textContent==='Book Again'));
});

test('PostgreSQL Book Again source ownership is relational; template creates no reservation',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const u=new URL(process.env.ER_TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.pathname.startsWith('/er_test_'));
 const admin=new Pool({connectionString:u.toString()}),schema='again_test_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:u.toString(),options:'-c search_path='+schema}),store=require('../storage/postgres').createStore({},pool);t.after(async()=>{await store.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await store.migrate();
 const h=await harness(t,{},'[]',store),a=await register(h),b=await register(h,{email:'foreign-pg-again@example.test',phone:'2025550192'}),old=await h.request('/api/checkout',{...booking,paymentChoice:'later'},{cookie:cookie(a)});
 const own=await h.request(templateUrl(old.body.bookingId),undefined,{cookie:cookie(a)});assert.equal(own.status,200);assert.equal(own.body.template.vehicle,booking.vehicle);assert.equal((await h.request(templateUrl(old.body.bookingId),undefined,{cookie:cookie(b)})).status,404);
 assert.equal((await pool.query('SELECT count(*)::int n FROM er_reservations')).rows[0].n,1);
 const fresh=await h.request('/api/checkout',{...booking,...own.body.template,bookingFlow:own.body.flowReference,date:'2026-12-10',paymentChoice:'later'},{cookie:cookie(a)});assert.equal(fresh.status,200);assert.notEqual(fresh.body.bookingId,old.body.bookingId);assert.equal((await store.get(fresh.body.bookingId)).quote.total,100);assert.equal(await store.reservationOwner(fresh.body.bookingId),await store.reservationOwner(old.body.bookingId));
 assert.equal((await pool.query('SELECT count(*)::int n FROM er_reservations')).rows[0].n,2);
 // Real PostgreSQL source markers restore only offer intent, not an old stored fare.
 ewrPricingFixture(h);
 const specialSource=await h.request('/api/checkout',{...ewrTrip,offerCode:'EWR_MANHATTAN_SUV',paymentChoice:'later'}, {cookie:cookie(a)});assert.equal(specialSource.status,200);
 await store.update(specialSource.body.bookingId,r=>{r.quote.total=999;});
 const specialTemplate=await h.request(templateUrl(specialSource.body.bookingId),undefined,{cookie:cookie(a)});assert.equal(specialTemplate.body.template.offerCode,'EWR_MANHATTAN_SUV');
 const renewed=await h.request('/api/checkout',{...booking,...specialTemplate.body.template,pickupTerminal:'a',bookingFlow:specialTemplate.body.flowReference,date:'2026-12-11',paymentChoice:'later'}, {cookie:cookie(a)});assert.equal(renewed.status,200);assert.equal((await store.get(renewed.body.bookingId)).quote.total,150);assert.notEqual(renewed.body.bookingId,specialSource.body.bookingId);assert.equal((await store.get(specialSource.body.bookingId)).quote.total,999);
});

test('all approved EWR terminal templates reselect canonical identities and require fresh verification',async t=>{
 const ids={general:booking.pickupPlaceId,a:'ChIJ2dQDPZNSwokRVJr9XE2SPt0',b:'ChIJ-6uTxfZSwokR-VfW-WSM53k',c:'ChIJMYEleJSwokRawcDBeH8NVg'};
 for(const [terminal,id] of Object.entries(ids)){
  const h=await harness(t);h.state.detailsById=Object.fromEntries(Object.entries(ids).map(([key,value])=>[value,{id:value,displayName:{text:key==='general'?'Newark Liberty International Airport':'Newark Liberty International Airport Terminal '+key.toUpperCase()},formattedAddress:'3 Brewster Rd, Newark, NJ',types:[key==='general'?'airport':'point_of_interest'],location:{latitude:40.6895,longitude:-74.1745}}]));const a=await register(h),auth={cookie:cookie(a)},old=await h.request('/api/checkout',{...booking,vehicle:'suv',tripType:'airport',pickup:terminal==='general'?'Newark Liberty International Airport (EWR)':'Newark Liberty International Airport Terminal '+terminal.toUpperCase(),pickupPlaceId:id,pickupTerminal:terminal,paymentChoice:'later'},auth);assert.equal(old.status,200);
  const response=await h.request(templateUrl(old.body.bookingId),undefined,auth);assert.equal(response.status,200);assert.equal(response.body.template.pickupPlaceId,id);
  const fresh=await h.request('/api/checkout',{...booking,...response.body.template,pickupTerminal:terminal,date:'2026-12-10',bookingFlow:response.body.flowReference,paymentChoice:'later'},auth);assert.equal(fresh.status,200);assert.notEqual(fresh.body.bookingId,old.body.bookingId);assert.equal(h.records().find(x=>x.id===fresh.body.bookingId).trip.pickupPlaceId,id);
  assert.deepEqual(h.state.detailsRequests,[terminal==='c'?ids.general:id,terminal==='c'?ids.general:id],'Both bookings independently verify the existing approved identity');
 }
});

const terminalAId='ChIJ2dQDPZNSwokRVJr9XE2SPt0',timesSquare='Times Square, Manhattan, NY, USA';
function ewrPricingFixture(h){
 h.state.detailsById={[terminalAId]:{id:terminalAId,displayName:{text:'Newark Liberty International Airport Terminal A'},formattedAddress:'3 Brewster Rd, Newark, NJ 07114, USA',types:['point_of_interest','establishment'],location:{latitude:40.6895,longitude:-74.1745}}};
 h.state.searchResults={[timesSquare]:[{id:'mock_times_square',displayName:{text:'Times Square'},formattedAddress:timesSquare,types:['point_of_interest'],location:{latitude:40.758,longitude:-73.9855},addressComponents:[{types:['administrative_area_level_2'],longText:'New York County'}]}]};
 h.state.routeResult=()=>({distanceMeters:22.31*1609.344,duration:'1200s'});
}
const ewrTrip={...booking,pickup:'Newark Liberty International Airport Terminal A',pickupPlaceId:terminalAId,pickupTerminal:'a',dropoff:timesSquare,vehicle:'suv',tripType:'airport'};
function formPayload(ui,template){
 const src=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
 ui.ctx.ewrTerminalChoices={general:{id:booking.pickupPlaceId},a:{id:terminalAId}};
 ui.ctx.pickupTerminal={disabled:true,value:''};ui.ctx.dropoffTerminal={disabled:true,value:''};
 ui.ctx.pickupTerminalField={classList:{toggle(){}}};ui.ctx.dropoffTerminalField={classList:{toggle(){}}};
 for(const name of ['syncPickupTerminal','syncDropoffTerminal']){
  const start=src.indexOf('function '+name+'()'),end=src.indexOf((name==='syncPickupTerminal'?'pickupTerminal':'dropoffTerminal')+'.addEventListener(',start);
  vm.runInContext(src.slice(start,end),ui.ctx);
 }
 ui.ctx.syncPickupTerminal();ui.ctx.syncDropoffTerminal();
 ui.ctx.FormData=function(){this.entries=()=>Object.entries({...booking,tripType:template.tripType,pickup:ui.fields.pickup.value,dropoff:ui.fields.dropoff.value,vehicle:ui.fields.vehicle.value,passengers:ui.fields.passengers.value,date:ui.fields.dateInput.value,time:ui.fields.timeInput.value,promoCode:ui.fields.promoCode.value,offerCode:ui.fields.offerCode.value});};
 const start=src.indexOf('function getFormData()'),end=src.indexOf('/* =========================================',start);
 vm.runInContext(src.slice(start,end),ui.ctx);return JSON.parse(JSON.stringify(ui.ctx.getFormData()));
}
test('reproduction: canonical Terminal A identity alone uses normal $129.24; explicitly selected EWR special uses $150',async t=>{
 const h=await harness(t);ewrPricingFixture(h);
 const normal=await h.request('/api/quote',ewrTrip);assert.equal(normal.status,200);assert.equal(normal.body.total,129.24);assert.equal(normal.body.fixedOffer,null);
 const firstRide=await h.request('/api/quote',{...ewrTrip,promoCode:'FIRST15'});assert.equal(firstRide.status,200);assert.equal(firstRide.body.discount,19.39);assert.equal(firstRide.body.total,109.85);assert.equal(require('../pricing').promotions.FIRST15.percentOff,15);
 const special=await h.request('/api/quote',{...ewrTrip,offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'});assert.equal(special.status,200);assert.equal(special.body.total,150);assert.equal(special.body.discount,0);assert.equal(special.body.promotion,null);assert.equal(special.body.fixedOffer.code,'EWR_MANHATTAN_SUV');
});
test('Book Again restores prior verified EWR special selection through real prefill/payload and fresh server verification, never old fare',async t=>{
 const h=await harness(t);ewrPricingFixture(h);const a=await register(h),auth={cookie:cookie(a)},source=await h.request('/api/checkout',{...ewrTrip,offerCode:'EWR_MANHATTAN_SUV',paymentChoice:'later'},auth);assert.equal(source.status,200);
 await h.testStore.update(source.body.bookingId,r=>{r.quote.total=999;});
 const response=await h.request(templateUrl(source.body.bookingId),undefined,auth);assert.equal(response.status,200);
 const ui=bookingUi();ui.ctx.applyPromoBtn={disabled:false};ui.ctx.showSpecialPromoMessage=()=>{};ui.ctx.applyBookAgainTemplate(response.body.template,response.body.flowReference);
 ui.fields.dateInput.value='2026-12-10';ui.fields.timeInput.value='12:00';
 const payload=formPayload(ui,response.body.template);assert.equal(payload.pickupPlaceId,terminalAId);assert.equal(payload.pickupTerminal,'a');assert.equal(payload.dropoff,timesSquare);assert.equal(payload.vehicle,'suv');
 assert.equal(payload.offerCode,'EWR_MANHATTAN_SUV','Book Again must retain the selected public offer, not just its airport identity');assert.equal(ui.fields.promoCode.disabled,true);assert.equal(ui.ctx.applyPromoBtn.disabled,true);assert.ok(!Object.hasOwn(payload,'total'));assert.ok(!Object.hasOwn(payload,'amount'));
 const normalSpecial=await h.request('/api/quote',{...ewrTrip,date:payload.date,time:payload.time,offerCode:'EWR_MANHATTAN_SUV'}),again=await h.request('/api/quote',payload);assert.equal(again.status,200);assert.equal(again.body.total,150);assert.equal(again.body.total,normalSpecial.body.total);assert.equal(again.body.fixedOffer.code,normalSpecial.body.fixedOffer.code);assert.equal(again.body.discount,0);
 const unpaid=await h.request('/api/checkout',{...payload,paymentChoice:'later'},auth);assert.equal(unpaid.status,200);assert.notEqual(unpaid.body.bookingId,source.body.bookingId);assert.equal(h.records().find(r=>r.id===unpaid.body.bookingId).quote.total,150);assert.equal(h.records().find(r=>r.id===source.body.bookingId).quote.total,999);
 const missingIdentity={...payload};delete missingIdentity.pickupPlaceId;assert.equal((await h.request('/api/quote',missingIdentity)).status,400);
 const nonManhattan='Jersey City, NJ, USA';h.state.searchResults[nonManhattan]=[{id:'mock_jersey',addressComponents:[{types:['administrative_area_level_2'],longText:'Hudson County'}]}];assert.equal((await h.request('/api/quote',{...payload,dropoff:nonManhattan})).status,400);
 assert.equal((await h.request('/api/quote',{...payload,promoCode:'FIRST15'})).body.total,150);
});
test('ordinary EWR Book Again and other routes retain normal pricing; prior FIRST15 redemption is not copied',async t=>{
 const h=await harness(t);ewrPricingFixture(h);const a=await register(h),auth={cookie:cookie(a)},old=await h.request('/api/checkout',{...ewrTrip,promoCode:'FIRST15',paymentChoice:'later'},auth);assert.equal(old.status,200);assert.equal(h.records()[0].quote.total,109.85);
 const response=await h.request(templateUrl(old.body.bookingId),undefined,auth);assert.ok(!Object.hasOwn(response.body.template,'offerCode'));assert.ok(!Object.hasOwn(response.body.template,'promoCode'));
 const ui=bookingUi();ui.ctx.applyBookAgainTemplate(response.body.template,response.body.flowReference);ui.fields.dateInput.value='2026-12-10';ui.fields.timeInput.value='12:00';const payload=formPayload(ui,response.body.template);assert.equal(payload.offerCode,'');assert.equal(payload.promoCode,'');
 const fresh=await h.request('/api/quote',payload),normal=await h.request('/api/quote',{...ewrTrip,date:payload.date,time:payload.time});assert.equal(fresh.status,200);assert.equal(fresh.body.total,normal.body.total);assert.equal(fresh.body.total,129.24);assert.equal(fresh.body.fixedOffer,null);assert.equal(fresh.body.discount,0);
 const other=await h.request('/api/quote',{...booking,pickup:'123 Main Street, Newark, NJ',dropoff:'Philadelphia, PA',vehicle:'suv',pickupPlaceId:undefined,pickupTerminal:undefined});assert.equal(other.status,200);assert.equal(other.body.total,129.24);assert.equal(other.body.fixedOffer,null);
 assert.equal((await h.request('/api/checkout',{...payload,promoCode:'FIRST15',paymentChoice:'later'},auth)).status,409,'New flow cannot claim FIRST15 again while source claim is held');
});
test('offer restoration requires verified source marker and existing vehicle/type/pickup guards',()=>{
 const source={trip:{...ewrTrip,offerCode:'EWR_MANHATTAN_SUV'},quote:{total:999,fixedOffer:{code:'EWR_MANHATTAN_SUV',price:999}}};
 const template=reusableTrip(source);assert.equal(template.offerCode,'EWR_MANHATTAN_SUV');assert.ok(!Object.hasOwn(template,'total'));assert.ok(!Object.hasOwn(template,'price'));
 for(const trip of [{...source.trip,vehicle:'escalade'},{...source.trip,tripType:'roundtrip'},{...source.trip,pickupPlaceId:'forged_place'}])assert.ok(!Object.hasOwn(reusableTrip({...source,trip}),'offerCode'));
 assert.ok(!Object.hasOwn(reusableTrip({...source,quote:{total:150,fixedOffer:null}}),'offerCode'),'Browser-originated/stored text offer alone is insufficient');
 assert.ok(!Object.hasOwn(reusableTrip({...source,quote:{total:150,fixedOffer:{code:'OTHER'}}}),'offerCode'));
 const src=fs.readFileSync(path.join(__dirname,'../storage/customer-trips.js'),'utf8'),context={ewr:require('../ewr-pickups'),pricing:{fixedOffers:{EWR_MANHATTAN_SUV:{active:false,vehicle:'suv'}}}};
 vm.createContext(context);vm.runInContext(src.slice(src.indexOf('function reusableTrip('),src.indexOf('function tripDto(')),context);assert.ok(!Object.hasOwn(context.reusableTrip(source),'offerCode'),'Inactive offer must not be restored');
});
