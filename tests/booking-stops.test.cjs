'use strict';

const test=require('node:test'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const fs=require('node:fs'), path=require('node:path'), {parse:parseEnv}=require('dotenv');
const stops=require('../services/booking-stops');
const tolls=require('../services/route-tolls');
const {validateRecord}=require('../storage/postgres');
const {encode}=require('./helpers/official-toll-fixtures.cjs');
const {geometry}=require('../services/toll-route-evidence');
const {route: tollFixture}=require('./helpers/booking-browser.cjs');
const {setup,base,queue,initialClock}=require('./helpers/reservation-management.cjs');
const {places,place,requested,providerRoute,configure,fixture,trip}=require('./helpers/booking-stops.cjs');

const approvedRateConfig='{"suv":150,"escalade":150}';
const alternativeRateConfig='{"suv":175,"escalade":150}';
const checkout=(input,quote,paymentChoice='later',extra={})=>({...input,paymentChoice,quoteRevision:quote.quoteRevision,...extra});
const assertOK=(result,status=200)=>assert.equal(result.status,status,JSON.stringify(result.body));
const dollars=value=>Math.round(value*100);
const quote=async(h,input)=>{const result=await h.request('/api/quote',input);assertOK(result);return result.body;};
const access=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
const pg={skip:!process.env.ER_TEST_DATABASE_URL && 'Requires an isolated PostgreSQL database'};

test('both vehicles apply the approved 150-cent rate separately to each scheduled stop',()=>{
 const {BOOKING_STOP_WAITING_RATES_CENTS_JSON:example}=parseEnv(fs.readFileSync(path.join(__dirname,'../.env.example')));
 assert.equal(example,approvedRateConfig);
 const cases=[
  [[5],0,0], [[10],5,750], [[15],10,1500], [[20],15,2250], [[30],25,3750],
  [[10,15],15,2250], [[30,30,30],75,11250], [[5,5,5],0,0]
 ];
 for(const vehicle of ['suv','escalade']) for(const configured of [undefined,'','  ',example]){
  for(const [waits,billableMinutes,chargeCents] of cases){
   const requestedStops=waits.map((minutes,index)=>requested(['first','second','third'][index],minutes));
   const plannedMinutes=waits.reduce((total,minutes)=>total+minutes,0);
   const plan=stops.waitingPlan(requestedStops,vehicle,configured);
   assert.deepEqual(plan,{plannedMinutes,billableMinutes,rateCentsPerMinute:billableMinutes ? 150 : null,chargeCents});
   assert.equal(plannedMinutes-plan.billableMinutes,waits.length*5);
  }
 }
});

test('invalid explicit rates block billable waiting and leave the free allowance available',()=>{
 for(const vehicle of ['suv','escalade']){
  for(const invalid of ['not JSON','{}','[]','null','{"suv":"150","escalade":"150"}',
   '{"suv":0,"escalade":0}','{"suv":-1,"escalade":-1}','{"suv":1.5,"escalade":1.5}',
   '{"suv":9007199254740991,"escalade":9007199254740991}']){
   assert.throws(()=>stops.waitingPlan([requested('first',10)],vehicle,invalid),{message:stops.errors.rate});
   assert.equal(stops.waitingPlan([requested('first')],vehicle,invalid).chargeCents,0);
  }
  const otherVehicle=vehicle==='suv'?'escalade':'suv';
  assert.throws(()=>stops.waitingPlan([requested('first',10)],vehicle,JSON.stringify({[otherVehicle]:150})),
   {message:stops.errors.rate});
 }
 assert.throws(()=>stops.waitingPlan([requested('first',10)],'unconfigured'),{message:stops.errors.rate});
});

test('toll geometry offsets downstream crossings by scheduled waits without adding them to driving times',()=>{
 const points=[[-74.03,40.76],[-74.02,40.76],[-74.01,40.76],[-74,40.76],[-73.99,40.76]];
 const data={distanceMeters:5000,duration:'1200s',staticDuration:'1200s',legs:points.slice(1).map((point,index)=>
  ({steps:[{staticDuration:'300s',polyline:{encodedPolyline:encode([points[index],point])}}]}))};
 const result=geometry(data,[300,600,900]);
 assert.deepEqual(result.segments.map(({start,end})=>[start,end]),[[0,300],[600,900],[1500,1800],[2700,3000]]);
 assert.equal(result.travel,3000);
 assert.equal(data.duration,'1200s');
 assert.throws(()=>geometry(data,[300]),{reason:'geometry_missing'});
});

test('no-stop pricing, one to three ordered stop legs, and free waiting use one complete Google route',async t=>{
 const h=await fixture(t);
 const direct=await quote(h,{...trip,stops:[]});
 assert.equal(direct.stopSummary,undefined);
 assert.match(direct.quoteRevision,/^[a-f0-9]{64}$/);
 assert.equal(h.state.routes[0].intermediates,undefined);
 for(const count of [1,2,3]){
  const requestedStops=['first','second','third'].slice(0,count).reverse().map(key=>requested(key));
  const result=await quote(h,{...trip,stops:requestedStops});
  const request=h.state.routes.at(-1);
  assert.deepEqual(request.intermediates,requestedStops.map(({placeId})=>({placeId})));
  assert.equal(request.optimizeWaypointOrder,undefined);
  assert.equal(h.state.routes.length,count+1);
  const route=providerRoute(request);
  assert.equal(result.miles,Math.round(route.distanceMeters/1609.344*100)/100);
  assert.equal(result.minutes,Number(route.duration.slice(0,-1))/60);
  assert.equal(result.stopSummary.chargeCents,0);
  assert.equal(result.stopSummary.freeMinutes,count*5);
  assert.equal(result.stopSummary.billableMinutes,0);
  assert.deepEqual(result.stopSummary.stops.map(value=>value.address),requestedStops.map(value=>value.address));
  assert.ok(result.total>direct.total);
  assert.equal(result.tolls.amountCents,2300);
  assert.doesNotMatch(JSON.stringify(result.stopSummary),/placeId|fixture_stop/);
  assert.equal(result.stopPlan,undefined);
 }
});

test('invalid counts, unsupported types, manipulated waits, unresolved addresses and duplicate places fail closed',async t=>{
 const h=await fixture(t);
 const bad=[
  {...trip,stops:null}, {...trip,stops:Array(4).fill(requested('first'))},
  {...trip,tripType:'hourly',hours:3}, {...trip,tripType:'roundtrip',returnDate:'2026-11-11',returnTime:'15:00'},
  {...trip,stops:[{...requested('first'),waitMinutes:'5'}]}, {...trip,stops:[requested('first',31)]},
  {...trip,stops:[{...requested('first'),placeId:''}]}, {...trip,stops:[{...requested('first'),rateCents:0}]},
  {...trip,stops:[requested('first'),requested('first')]}
 ];
 for(const input of bad)assert.equal((await h.request('/api/quote',input)).status,400);
 assert.equal(h.state.routes.length,0);
 assert.equal(h.records().length,0);
 const invalid={...places.first,id:'fictional_city',address:'Newark, NJ, USA'};
 h.state.detailsById[invalid.id]={...place(invalid),types:['locality'],primaryType:'locality'};
 assert.equal((await h.request('/api/quote',{...trip,stops:[{address:invalid.address,placeId:invalid.id,waitMinutes:5}]})).body.error,stops.errors.invalid);
 for(const key of ['pickup','destination'])assert.equal((await h.request('/api/quote',{...trip,stops:[requested(key)]})).body.error,stops.errors.duplicate);
 const alternate={...places.first,id:'alias_same_location',address:'42 Example St Suite 1, Newark, NJ 07102, USA'};
 h.state.detailsById[alternate.id]=place(alternate);
 assert.equal((await h.request('/api/quote',{...trip,stops:[requested('first'),{address:alternate.address,placeId:alternate.id,waitMinutes:5}]})).body.error,stops.errors.duplicate);
 assert.equal(h.state.routes.length,0);
});

test('malformed waiting configuration and incomplete route or toll evidence prevent booking',async t=>{
 const h=await fixture(t,{BOOKING_STOP_WAITING_RATES_CENTS_JSON:'not JSON'});
 const waiting={...trip,stops:[requested('first',10)]};
 const blocked=await h.request('/api/quote',waiting);
 assert.equal(blocked.status,422);
 assert.equal(blocked.body.error,stops.errors.rate);
 assert.equal(h.state.routes.length,0);
 assert.equal((await h.request('/api/checkout',{...waiting,paymentChoice:'later',quoteRevision:'a'.repeat(64)})).status,422);
 h.state.routeResult=request=>({...providerRoute(request),legs:[]});
 assert.equal((await h.request('/api/quote',trip)).body.error,stops.errors.route);
 h.state.routeResult=request=>({...providerRoute(request),travelAdvisory:{tollInfo:{}}});
 assert.equal((await h.request('/api/quote',trip)).body.code,'TOLL_ESTIMATE_UNAVAILABLE');
 h.state.googleError=true;
 assert.ok((await h.request('/api/quote',trip)).status>=400);
 assert.equal(h.records().length,0);
 assert.equal(h.state.creates.length,0);
});

test('same-state endpoints retain the toll waiver and the $150 airport special is nonstop only',async t=>{
 const h=await fixture(t);
 const local=await quote(h,{...trip,dropoff:places.local.address,stops:[requested('third')]});
 assert.equal(local.tolls.status,'waived');
 assert.equal(local.tolls.amountCents,0);
 assert.equal(h.state.routes.at(-1).extraComputations,undefined);
 const special={...trip,pickup:'EWR',pickupPlaceId:'ChIJ7wzsxeFSwokRhvLXxTe087M',pickupTerminal:'general',
  tripType:'airport',dropoff:'Manhattan',offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'};
 const nonstop=await quote(h,{...special,stops:[]});
 assert.equal(nonstop.total,150);
 assert.equal(nonstop.tolls.status,'included');
 assert.equal(nonstop.promotion,null);
 const withStop=await quote(h,special);
 assert.equal(withStop.fixedOffer,null);
 assert.equal(withStop.nonstopOfferExcluded,true);
 assert.equal(withStop.promotion.code,'FIRST15');
 assert.notEqual(withStop.total,150);
 assert.equal(h.state.routes.at(-1).intermediates.length,1);
});

test('the existing primary toll estimator prices a stopped route once when crossing evidence is complete',async t=>{
 const h=await fixture(t);
 h.state.routeResult=request=>{
  const priced=tollFixture({crossing:'lincoln',direction:'ny_bound',street:'W  42 ST'},2500);
  const steps=priced.legs[0].steps;
  const middle=Math.max(1,Math.floor(steps.length/3));
  const metrics=providerRoute(request,2500);
  priced.legs=metrics.legs.map((leg,i)=>({...leg,steps:i===0?steps.slice(0,middle):steps.slice(middle)}));
  return priced;
 };
 const quoted=await quote(h,trip);
 assertOK(await h.request('/api/checkout',checkout(trip,quoted)));
 const {quote:saved}=h.records()[0];
 assert.equal(saved.tolls.format,'advance_estimate_2026');
 assert.equal(saved.tolls.legs.length,1);
 assert.equal(saved.tolls.amountCents,Math.max(saved.tolls.legs[0].googleRouteCents,saved.tolls.legs[0].officialSubtotalCents));
 assert.equal(saved.totalCents,dollars(saved.discountedFare)+saved.tolls.amountCents);
});

test('both vehicles add the same approved waiting fee once and retain their FIRST15 fare and toll calculation',async t=>{
 const h=await fixture(t);
 const regularFares=[];
 for(const vehicle of ['suv','escalade']){
  const baseQuote=await quote(h,{...trip,vehicle,promoCode:'FIRST15',stops:[requested('first'),requested('second')]});
  const selected=await quote(h,{...trip,vehicle,promoCode:'FIRST15',stops:[requested('first',10),requested('second',15)],
   rateCentsPerMinute:1,chargeCents:1,stopSummary:{rateCentsPerMinute:1,chargeCents:1},BOOKING_STOP_WAITING_RATES_CENTS_JSON:'{}'});
  assert.equal(selected.promotion.code,'FIRST15');
  assert.equal(selected.discount,baseQuote.discount);
  assert.equal(selected.tolls.amountCents,baseQuote.tolls.amountCents);
  assert.equal(selected.stopSummary.rateCentsPerMinute,150);
  assert.equal(selected.stopSummary.chargeCents,2250);
  assert.equal(selected.totalCents,baseQuote.totalCents+2250);
  assert.equal(selected.minutes,baseQuote.minutes);
  assert.equal(selected.miles,baseQuote.miles);
  regularFares.push(baseQuote.totalCents);
 }
 assert.ok(regularFares[1]>regularFares[0]);
});

test('stop order, waiting and quote revisions bind checkout even with toll pricing disabled',async t=>{
 const h=await fixture(t,{ROUTE_TOLLS_ENABLED:'false'});
 const input={...trip,stops:[requested('first',10),requested('second',15)]};
 const before=await quote(h,input);
 const after=await quote(h,{...input,stops:[...input.stops].reverse()});
 assert.equal(before.total,after.total);
 assert.notEqual(before.quoteRevision,after.quoteRevision);
 for(const tampered of [
  checkout({...input,stops:[...input.stops].reverse()},before),
  checkout({...input,stops:[requested('first',15),requested('second',15)]},before),
  checkout({...input,stops:[]},before),
  {...input,paymentChoice:'later'},
  checkout(input,before,'later',{quoteRevision:'a'.repeat(64)})
 ])assert.equal((await h.request('/api/checkout',tampered)).status,409);
 assert.equal(h.records().length,0);
});

test('a changed server waiting rate invalidates an unaccepted quote before booking or payment',async t=>{
 const h=await fixture(t);
 const input={...trip,stops:[requested('first',10)]};
 const reviewed=await quote(h,input);
 h.context.process.env.BOOKING_STOP_WAITING_RATES_CENTS_JSON=alternativeRateConfig;
 for(const choice of ['now','later'])assert.equal((await h.request('/api/checkout',checkout(input,reviewed,choice))).status,409);
 assert.equal(h.records().length,0);
 assert.equal(h.state.creates.length,0);
 const refreshed=await quote(h,input);
 assert.notEqual(refreshed.quoteRevision,reviewed.quoteRevision);
 assert.equal(refreshed.stopSummary.rateCentsPerMinute,175);
 assert.equal(refreshed.totalCents,reviewed.totalCents+125);
});

test('an unaccepted stop quote expires at scheduled pickup on the server clock',async t=>{
 const h=await fixture(t);
 const input={...trip,stops:[requested('first',10)]};
 const reviewed=await quote(h,input);
 const departure=Date.parse(h.state.routes.at(-1).departureTime);
 h.advance(departure-initialClock-1);
 assert.equal((await quote(h,input)).quoteRevision,reviewed.quoteRevision);
 const lookups=h.state.googleCalls;
 h.advance(1);
 for(const choice of ['now','later']){
  const expired=await h.request('/api/checkout',checkout(input,reviewed,choice));
  assert.equal(expired.status,400);
  assert.equal(expired.body.error,'Pickup must be scheduled in the future (New York time).');
 }
 assert.equal(h.state.googleCalls,lookups);
 assert.equal(h.records().length,0);
 assert.equal(h.state.creates.length,0);
});

for(const [vehicle,choice] of [['suv','now'],['escalade','later']])
test('authoritative '+vehicle+' stop total is frozen through '+choice+' and signed payment confirmation',async t=>{
 const h=await fixture(t);
 const input={...trip,vehicle,stops:[requested('first',10),requested('second',30)]};
 const quoted=await quote(h,input);
 const accepted=await h.request('/api/checkout',checkout(input,quoted,choice,{total:1,waitingCents:0,tollTotal:0,distance:0,
  rateCentsPerMinute:1,stopPlan:{rateCentsPerMinute:1,chargeCents:0}}));
 assertOK(accepted);
 const saved=h.records()[0], cookies=access(accepted);
 assert.equal(saved.quote.total,quoted.total);
 assert.equal(saved.quote.stopPlan.rateCentsPerMinute,150);
 assert.equal(saved.quote.stopPlan.chargeCents,4500);
 assert.equal(saved.quote.stopPlan.stops[1].placeId,places.second.id);
 assert.equal(tolls.validQuote(saved.quote),true);
 assert.doesNotThrow(()=>validateRecord(saved));
 const modified=structuredClone(saved);
 modified.quote.stopPlan.stops.reverse();
 assert.throws(()=>validateRecord(modified));
 if(choice==='later'){
  assert.equal(h.state.creates.length,0);
  h.context.process.env.BOOKING_STOP_WAITING_RATES_CENTS_JSON='not JSON';
  const origin={cookie:cookies,origin:new URL(accepted.body.url).origin,'sec-fetch-site':'same-origin'};
  assert.equal((await h.request('/api/booking/'+saved.id+'/checkout',{actualWait:60,additionalCharge:999},origin)).status,403);
  assert.equal(h.state.creates.length,0);
  const payment=await h.request('/api/booking/'+saved.id+'/checkout',{}, origin);
  assertOK(payment);
 }
 assert.equal(h.state.creates.length,1);
 assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,dollars(quoted.total));
 const duplicate=await h.request('/api/checkout',checkout(input,quoted,choice),{cookie:cookies});
 assertOK(duplicate);
 assert.equal(h.records().length,1);
 assert.equal(h.state.creates.length,1);
 const session=[...h.state.sessions.values()][0];
 session.status='complete';session.payment_status='paid';
 assertOK(await h.webhook(session));
 assert.equal(h.records()[0].paymentStatus,'paid');
 assert.equal(h.records()[0].quote.total,quoted.total);
 const privateStatus=await h.request('/api/booking/'+saved.id);
 assert.equal(privateStatus.status,401);
 const summary=await h.request('/api/booking/'+saved.id,undefined,{cookie:cookies});
 assertOK(summary);
 assert.equal(summary.body.trip.stopSummary.stops[1].plannedMinutes,30);
});

test('a lost Stripe response retries the same stopped reservation and idempotent payment',async t=>{
 const h=await fixture(t);
 const input={...trip,stops:[requested('first',10)]};
 const quoted=await quote(h,input);
 h.state.loseResponse=true;
 const lost=await h.request('/api/checkout',checkout(input,quoted,'now'));
 assert.ok(lost.status>=500);
 assert.equal(h.records().length,1);
 const retry=await h.request('/api/checkout',checkout(input,quoted,'now'),{cookie:access(lost)});
 assertOK(retry);
 assert.equal(h.records().length,1);
 assert.equal(h.state.sessions.size,1);
 assert.equal(new Set(h.state.creates.map(call=>call.options.idempotencyKey)).size,1);
 assert.ok(h.state.creates.every(call=>call.params.line_items[0].price_data.unit_amount===quoted.totalCents));
});

test('PostgreSQL stores the ordered accepted plan, dispatches confirmation email and queues authorized changes',pg,async t=>{
 const f=await setup(t,{ROUTE_TOLLS_ENABLED:'true',BOOKING_STOP_WAITING_RATES_CENTS_JSON:approvedRateConfig});
 configure(f.h);
 const owner=await f.register({email:trip.email,phone:trip.phone});
 const input={...trip,stops:[requested('first',15),requested('second')]};
 const preview=await f.post('/api/quote',input,owner);assertOK(preview);
 const quoted=preview.body;
 const accepted=await f.post('/api/checkout',checkout(input,quoted),owner);
 assertOK(accepted);
 const id=accepted.body.bookingId;
 const stored=await f.store.getForDisplay(id);
 assert.match(stored.bookingReference,/^ER-[0-9]{6}$/);
 assert.equal(stored.quote.stopPlan.chargeCents,1500);
 assert.equal(stored.quote.stopQuoteRevision,quoted.quoteRevision);
 assert.equal(stored.quote.total,quoted.total);
 await assert.rejects(f.store.update(id,record=>{record.quote.stopPlan.chargeCents=0;}));
 const customer=await f.get('/api/customer/trips/'+id,owner);
 assertOK(customer);
 assert.deepEqual(customer.body.trip.stopSummary.stops.map(stop=>stop.address),input.stops.map(stop=>stop.address));
 const again=await f.get('/api/customer/trips/'+id+'/book-again',owner);
 assertOK(again);
 assert.deepEqual(again.body.template.stops,input.stops);
 const admin=await f.adminLogin();
 const dispatch=await f.get('/api/bookings/search?status=all&timing=all',admin);
 assertOK(dispatch);
 assert.equal(dispatch.body.bookings.find(item=>item.id===id).trip.stopSummary.chargeCents,1500);
 for(let tries=0;tries<100&&!f.h.state.bookingMessages.some(message=>message.to===input.email);tries++){
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 const message=f.h.state.bookingMessages.find(email=>email.to===input.email);
 assert.ok(message);
 assert.ok(message.text.indexOf('Stop 1:')<message.text.indexOf('Stop 2:'));
 assert.ok(message.text.indexOf('Stop 2:')<message.text.indexOf('Final destination:'));
 assert.match(message.text,/Additional Stop Waiting: \$15\.00/);
 assert.ok(message.text.includes(stored.bookingReference));
 const path=base+'/account/'+id+'/requests';
 const proposal={requestId:crypto.randomUUID(),kind:'locations',confirmed:true,pickup:'',dropoff:'',
  stops:[requested('second',20),requested('first')]};
 const outsider=await f.register({email:'other-stop-account@example.test',phone:'2015550173'});
 assert.equal((await f.post(path,proposal,outsider)).status,404);
 const queued=await f.post(path,proposal,owner);
 assertOK(queued);
 assert.equal(queued.body.request.status,'pending');
 assert.deepEqual(queued.body.request.details.stops,proposal.stops);
 const replay=await f.post(path,proposal,owner);
 assertOK(replay);
 assert.equal(replay.body.request.id,queued.body.request.id);
 const decided=await f.post(queue+'/'+queued.body.request.id+'/decision',{status:'approved',confirmed:true},admin);
 assertOK(decided);
 assert.equal(decided.body.request.status,'approved');
 const stillAccepted=await f.store.getForDisplay(id);
 assert.deepEqual(stillAccepted.quote.stopPlan,stored.quote.stopPlan);
 assert.equal(stillAccepted.quote.total,stored.quote.total);
 assert.equal(f.h.state.creates.length,0);
});

test('isolated PostgreSQL retains a historical accepted waiting rate after the default takes effect',pg,async t=>{
 const f=await setup(t,{ROUTE_TOLLS_ENABLED:'true',BOOKING_STOP_WAITING_RATES_CENTS_JSON:alternativeRateConfig});
 configure(f.h);
 const owner=await f.register({email:trip.email,phone:trip.phone});
 const input={...trip,stops:[requested('first',10)]};
 const preview=await f.post('/api/quote',input,owner);assertOK(preview);
 const historical=preview.body;
 const accepted=await f.post('/api/checkout',checkout(input,historical),owner);
 assertOK(accepted);
 const id=accepted.body.bookingId;
 delete f.h.context.process.env.BOOKING_STOP_WAITING_RATES_CENTS_JSON;
 const current=await quote(f.h,input);
 assert.equal(current.stopSummary.rateCentsPerMinute,150);
 assert.equal(historical.totalCents,current.totalCents+125);
 assertOK(await f.post('/api/customer/trips/'+id+'/payment',{},owner));
 const saved=await f.store.getForDisplay(id);
 assert.equal(saved.quote.stopPlan.rateCentsPerMinute,175);
 assert.equal(saved.quote.stopPlan.chargeCents,875);
 assert.equal(saved.quote.totalCents,historical.totalCents);
 assert.equal(f.h.state.creates.length,1);
 assert.equal(f.h.state.creates[0].params.line_items[0].price_data.unit_amount,historical.totalCents);
});

test('an email-verified guest can request removal of stops without changing the accepted itinerary',pg,async t=>{
 const f=await setup(t,{ROUTE_TOLLS_ENABLED:'true'});
 configure(f.h);
 const quoted=await quote(f.h,trip);
 const accepted=await f.post('/api/checkout',checkout(trip,quoted));
 assertOK(accepted);
 const saved=await f.store.getForDisplay(accepted.body.bookingId);
 const path=base+'/guest/requests';
 const proposal={requestId:crypto.randomUUID(),kind:'locations',confirmed:true,pickup:'',dropoff:'',stops:[]};
 assert.equal((await f.post(path,proposal)).status,404);
 const guest=await f.verify(saved.bookingReference,trip.email);
 assert.ok(guest);
 const result=await f.post(path,proposal,guest);
 assertOK(result);
 assert.deepEqual(result.body.request.details.stops,[]);
 assert.equal(result.body.request.status,'pending');
 assert.deepEqual((await f.store.get(saved.id)).quote.stopPlan,saved.quote.stopPlan);
 assert.equal(f.h.state.creates.length,0);
});
