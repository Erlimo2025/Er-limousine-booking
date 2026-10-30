const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const factoryPath=path.join(__dirname,'security-abuse.test.cjs'),factorySource=fs.readFileSync(factoryPath,'utf8');
const {harness,booking}=new Function('require','__dirname',factorySource.slice(0,factorySource.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(factoryPath),__dirname);
const tolls=require('../services/route-tolls');
// Synthetic reviewed profile is a test fixture, not a claim about the ER fleet.
const profile={emissionType:'GASOLINE',tollPasses:['US_NJ_EZPASSNJ'],vehicleClass:'two_axle_passenger_equivalent',commercialRatesVerified:true,congestionCoverageVerified:true};
const enabled={ROUTE_TOLLS_ENABLED:'true',TOLL_VEHICLE_PROFILES_JSON:JSON.stringify({suv:profile,escalade:profile})};
const normal={...booking,vehicle:'suv',pickup:'Newark Penn Station, Newark, NJ',dropoff:'Midtown Manhattan, NY'};
const origin={origin:'http://localhost:3000','sec-fetch-site':'same-origin'};
const googleRoute=amount=>({distanceMeters:16093.44,duration:'1200s',...(amount===undefined?{}:{travelAdvisory:{tollInfo:amount===null?{}:{estimatedPrice:[{currencyCode:'USD',units:String(Math.floor(amount/100)),nanos:amount%100*10000000}]}}})});
const place=(state,id,address)=>({id,formattedAddress:address,displayName:{text:address},location:{latitude:40.7,longitude:-74.1},
 addressComponents:[{types:['country'],shortText:'US',longText:'United States'},{types:['administrative_area_level_1'],shortText:state,longText:{NJ:'New Jersey',NY:'New York',CT:'Connecticut',PA:'Pennsylvania'}[state]},...(state==='NY'?[{types:['administrative_area_level_2'],shortText:'New York County',longText:'New York County'}]:[])]});
const ids={newark:'ChIJ_toll_newark',midtown:'ChIJ_toll_midtown',trenton:'ChIJ_toll_trenton',stamford:'ChIJ_toll_stamford',ewr:'ChIJ7wzsxeFSwokRhvLXxTe087M'};
function configureLocations(h){h.state.searchResults={
 [normal.pickup]:[place('NJ',ids.newark,normal.pickup)],[normal.dropoff]:[place('NY',ids.midtown,normal.dropoff)],
 'Trenton, NJ':[place('NJ',ids.trenton,'Trenton, NJ')],'Stamford, CT':[place('CT',ids.stamford,'Stamford, CT')],
 'Philadelphia, PA':[place('PA','ChIJ_toll_philadelphia','Philadelphia, PA')],
 EWR:[place('NJ',ids.ewr,'Newark Liberty International Airport (EWR)')],
 'Newark Liberty International Airport (EWR)':[place('NJ',ids.ewr,'Newark Liberty International Airport (EWR)')],
 Manhattan:[place('NY',ids.midtown,'Manhattan, NY')]};return h;}
async function fixture(t,amount=1375,env=enabled){const h=configureLocations(await harness(t,env));h.state.routeResult=()=>googleRoute(amount);return h;}
const cookie=r=>r.headers.getSetCookie().find(value=>value.includes('er_customer_session'))?.split(';')[0];
const access=r=>r.headers.getSetCookie().filter(value=>value.includes('er_booking_')).map(value=>value.split(';')[0]).join('; ');

test('provider Money is strict USD integer cents, with omitted zero fields and half-up rounding; invalid or overflowing values remain unknown',()=>{
 for(const [money,cents]of [[{currencyCode:'USD'},0],[{currencyCode:'USD',units:'12'},1200],[{currencyCode:'USD',nanos:5000000},1],[{currencyCode:'USD',units:'12',nanos:349999999},1235],[{currencyCode:'USD',units:'0',nanos:999999999},100]])assert.equal(tolls.usdCents(money),cents);
 for(const money of [null,[],{}, {currencyCode:'usd',units:'2'},{currencyCode:'CAD',units:'2'},{currencyCode:'USD',units:2},{currencyCode:'USD',units:null},{currencyCode:'USD',units:'-1'},{currencyCode:'USD',units:'1e3'},{currencyCode:'USD',units:'1.5'},{currencyCode:'USD',units:'01'},{currencyCode:'USD',units:'9007199254740991'},{currencyCode:'USD',nanos:-1},{currencyCode:'USD',nanos:1000000000},{currencyCode:'USD',nanos:'500000000'},{currencyCode:'USD',nanos:NaN}])assert.equal(tolls.usdCents(money),null,JSON.stringify(money));
});

test('toll states use only the route-level total and never sum duplicate leg totals or assume a missing price is zero',()=>{
 assert.deepEqual(tolls.routeTolls(googleRoute()),{status:'none',amountCents:0});
 for(const route of [googleRoute(null),{travelAdvisory:{tollInfo:null}},{travelAdvisory:null},{travelAdvisory:{tollInfo:{estimatedPrice:[]}}},{legs:[{travelAdvisory:{tollInfo:{}}}]}])assert.deepEqual(tolls.routeTolls(route),{status:'unknown',amountCents:null});
 const route=googleRoute(1500);route.legs=[googleRoute(1500),googleRoute(1500)];assert.deepEqual(tolls.routeTolls(route),{status:'estimated',amountCents:1500});
 route.travelAdvisory.tollInfo.estimatedPrice.push({currencyCode:'CAD',units:'1'});assert.equal(tolls.routeTolls(route).status,'unknown');
});

test('a valid explicit zero-priced toll estimate adds no customer charge and is distinguished from an unknown cost',async t=>{
 const h=await fixture(t,0),q=await h.request('/api/quote',normal);assert.equal(q.status,200);assert.equal(q.body.tolls.status,'estimated');assert.equal(q.body.tolls.amountCents,0);assert.equal(q.body.total,80);assert.equal(q.body.pricingBreakdown.tollAllowanceCents,0);
 const receipt=require('../services/booking-emails').bookingMessage({trip:normal,quote:q.body,customer:{firstName:'Toll',lastName:'Fixture',email:'fixture@example.test'},paymentStatus:'unpaid',id:crypto.randomUUID()},'customer_reservation_created',{email:'support@example.test',phone:''});assert.match(receipt.text,/Tolls: No additional charge/);assert.doesNotMatch(receipt.text,/Tolls: Included in fare allowance/);
});

test('Routes requests retain distance/duration, request TOLLS once, and send only the server vehicle profile and scheduled departure',async t=>{
 const h=await fixture(t),r=await h.request('/api/quote',{...normal,tollPasses:['forged'],emissionType:'ELECTRIC',tollAmount:1});
 assert.equal(r.status,200);assert.deepEqual(h.state.routes[0].extraComputations,['TOLLS']);assert.deepEqual(h.state.routes[0].routeModifiers,{vehicleInfo:{emissionType:'GASOLINE'},tollPasses:['US_NJ_EZPASSNJ']});
 assert.equal(h.state.routeHeaders[0]['X-Goog-FieldMask'],'routes.distanceMeters,routes.duration,routes.travelAdvisory.tollInfo');assert.ok(!h.state.routeHeaders[0]['X-Goog-FieldMask'].includes('legs'));
 assert.equal(h.state.routes[0].departureTime,'2026-11-10T17:00:00.000Z');assert.equal(r.body.total,93.75);assert.equal(r.body.totalCents,9375);assert.equal(r.body.pricingBreakdown.tripFareCents,8000);assert.equal(r.body.pricingBreakdown.tollsCents,1375);
 assert.ok(!JSON.stringify(r.body).includes('mock-google-key'));assert.equal(h.records().length,0);
});

test('eligible interstate pricing counts the entire reported route including in-state roads, crossings and congestion, without adding duplicate leg prices',async t=>{
 const h=await fixture(t);h.state.routeResult=()=>{const route=googleRoute(2900);route.legs=[googleRoute(600),googleRoute(1400),googleRoute(900)];return route;};
 const q=await h.request('/api/quote',normal);assert.equal(q.status,200);assert.equal(q.body.tolls.estimatedRouteCents,2900);assert.equal(q.body.tolls.amountCents,2900);assert.equal(q.body.total,109);
 const r=await h.request('/api/checkout',{...normal,quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);assert.equal(h.records()[0].quote.total,109);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,10900);
});

test('verified interstate endpoints follow actual directional tolls while same-state tolled routes are waived',async t=>{
 const h=await fixture(t);h.state.routeResult=route=>googleRoute(route.origin.placeId===ids.midtown?250:route.destination.placeId===ids.trenton?400:route.destination.placeId===ids.stamford?undefined:1375);
 for(const [trip,amount,total,status]of [[normal,1375,93.75,'estimated'],[{...normal,pickup:normal.dropoff,dropoff:normal.pickup},250,82.50,'estimated'],[{...normal,dropoff:'Trenton, NJ'},0,80,'waived'],[{...normal,dropoff:'Stamford, CT'},0,80,'none']]){
  const r=await h.request('/api/quote',trip);assert.equal(r.status,200);assert.equal(r.body.tolls.amountCents,amount);assert.equal(r.body.total,total);assert.equal(r.body.tolls.status,status);
 }
});

test('same-state NJ and NY trips waive real or unknown road tolls, even without a verified company toll profile',async t=>{
 for(const state of ['NJ','NY'])for(const amount of [400,null]){
  const h=await fixture(t,amount,{ROUTE_TOLLS_ENABLED:'true'}),trip=state==='NJ'?{...normal,dropoff:'Trenton, NJ'}:{...normal,pickup:'Manhattan'};
  const q=await h.request('/api/quote',trip);assert.equal(q.status,200);assert.equal(q.body.total,80);assert.equal(q.body.tolls.status,'waived');assert.equal(q.body.tolls.amountCents,0);assert.equal(q.body.tolls.estimatedRouteCents,null);assert.equal(q.body.pricingBreakdown.interstate,false);assert.ok(tolls.validQuote(q.body));
  assert.equal(q.body.tolls.eligibility.pickupState,state);assert.equal(q.body.tolls.eligibility.dropoffState,state);assert.ok(h.state.routes.every(route=>route.extraComputations===undefined));
  const reserved=await h.request('/api/checkout',{...trip,quoteRevision:q.body.quoteRevision});assert.equal(reserved.status,200);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,8000);
  const receipt=require('../services/booking-emails').bookingMessage(h.records()[0],'customer_reservation_created',{email:'support@example.test',phone:''});assert.match(receipt.text,/No added tolls — same-state trip/);
 }
});

test('state eligibility ignores forged browser state/ID JSON and uses the very same verified IDs for routing',async t=>{
 const h=await fixture(t),r=await h.request('/api/quote',{...normal,pickupState:'NJ',dropoffState:'NJ',pickupPlaceId:'forged_nj',dropoffPlaceId:ids.newark,verifiedLocations:{pickupState:'NJ',dropoffState:'NJ'},tolls:{eligibility:{pickupState:'NJ',dropoffState:'NJ'}}});
 assert.equal(r.status,200);assert.equal(r.body.total,93.75);assert.equal(r.body.tolls.eligibility.pickupState,'NJ');assert.equal(r.body.tolls.eligibility.dropoffState,'NY');assert.equal(h.state.routes[0].origin.placeId,ids.newark);assert.equal(h.state.routes[0].destination.placeId,ids.midtown);
 const misleading=await fixture(t);misleading.state.searchResults[normal.dropoff]=[place('NJ',ids.trenton,'Provider-verified Trenton, NJ')];const q=await misleading.request('/api/quote',normal);assert.equal(q.status,200);assert.equal(q.body.tolls.status,'waived');assert.equal(misleading.state.routes[0].destination.placeId,ids.trenton);
});

test('missing, ambiguous, foreign, conflicting or malformed provider state evidence fails closed before route/checkout creation',async t=>{
 const valid=place('NY',ids.midtown,normal.dropoff),copy=()=>structuredClone(valid);
 const missing=copy();missing.addressComponents=missing.addressComponents.filter(item=>!item.types.includes('administrative_area_level_1'));
 const duplicate=copy();duplicate.addressComponents.push({types:['administrative_area_level_1'],shortText:'NJ'});
 const foreign=copy();foreign.addressComponents.find(item=>item.types.includes('country')).shortText='CA';
 const invalid=copy();invalid.addressComponents.find(item=>item.types.includes('administrative_area_level_1')).shortText='XX';
 const badPoint=copy();badPoint.location.latitude='40.7';
 const noCountry=copy();noCountry.addressComponents=noCountry.addressComponents.filter(item=>!item.types.includes('country'));
 for(const places of [[],[valid,place('NJ',ids.trenton,'Trenton, NJ')],[missing],[duplicate],[foreign],[invalid],[badPoint],[noCountry]]){
  const h=await fixture(t);h.state.searchResults[normal.dropoff]=places;
  for(const endpoint of ['/api/quote','/api/checkout']){const r=await h.request(endpoint,{...normal,dropoffState:'NJ',paymentChoice:'later'});assert.equal(r.status,422);assert.equal(r.body.code,'TOLL_ESTIMATE_UNAVAILABLE');assert.equal(r.body.checkoutAllowed,false);}
  assert.equal(h.state.routes.length,0);assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
 }
});

test('same-state round trips waive each direction without requiring toll prices or double-counting',async t=>{
 const h=await fixture(t,null,{ROUTE_TOLLS_ENABLED:'true'}),trip={...normal,dropoff:'Trenton, NJ',tripType:'roundtrip',returnDate:'2026-11-12',returnTime:'18:00'},q=await h.request('/api/quote',trip);
 assert.equal(q.status,200);assert.equal(q.body.total,160);assert.equal(q.body.tolls.status,'waived');assert.deepEqual(q.body.tolls.legs,[{status:'waived',amountCents:0},{status:'waived',amountCents:0}]);assert.equal(h.state.routes.length,2);assert.ok(h.state.routes.every(route=>!route.extraComputations));assert.equal(h.state.routes[1].origin.placeId,ids.trenton);assert.equal(h.state.routes[1].destination.placeId,ids.newark);
 const r=await h.request('/api/checkout',{...trip,paymentChoice:'later',quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);const calls=h.state.googleCalls;assert.equal((await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...origin,cookie:access(r)})).status,200);assert.equal(h.state.googleCalls,calls);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,16000);
});

test('same-state waivers preserve original discounts/surcharges and both payment choices while malformed saved policy fails closed',async t=>{
 for(const choice of ['now','later']){
  const h=await fixture(t,null,{ROUTE_TOLLS_ENABLED:'true'});vm.runInContext('pricing.lateNightSurcharge=7;',h.context);
  const trip={...normal,dropoff:'Trenton, NJ',time:'23:30',promoCode:'FIRST15'},q=await h.request('/api/quote',trip);assert.equal(q.status,200);assert.equal(q.body.baseTotal,87);assert.equal(q.body.discount,13.05);assert.equal(q.body.total,73.95);assert.equal(q.body.tolls.amountCents,0);
  const reserved=await h.request('/api/checkout',{...trip,paymentChoice:choice,quoteRevision:q.body.quoteRevision,total:1,tollAmount:99999});assert.equal(reserved.status,200);const accepted=h.records()[0];assert.equal(accepted.quote.total,73.95);assert.equal(accepted.quote.pricingBreakdown.interstate,false);
  if(choice==='later')assert.equal((await h.request('/api/booking/'+reserved.body.bookingId+'/checkout',{}, {...origin,cookie:access(reserved)})).status,200);
  assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,7395);
  for(const mutate of [q=>q.tolls.status='none',q=>q.tolls.amountCents=1,q=>q.tolls.eligibility.dropoffState='NY',q=>q.tolls.eligibility.pickupPlaceId='',q=>q.pricingBreakdown.interstate=true]){const broken=structuredClone(accepted);mutate(broken.quote);assert.equal(tolls.validQuote(broken.quote),false);assert.throws(()=>require('../storage/postgres').validateRecord(broken));}
 }
});

test('previously accepted same-state toll snapshots retain their stored price under the new interstate-only policy',async t=>{
 const old=await fixture(t,undefined,{}),trip={...normal,dropoff:'Trenton, NJ'},base=await old.request('/api/quote',trip),r=await old.request('/api/checkout',{...trip,paymentChoice:'later'}),record=old.records()[0];
 record.quote=tolls.attachTolls(base.body,tolls.aggregateTolls([tolls.routeTolls(googleRoute(400))],tolls.vehicleProfile(enabled,'suv')));
 assert.equal(record.quote.total,84);assert.equal(record.quote.tolls.eligibility,undefined);assert.ok(tolls.validQuote(record.quote));
 const h=await harness(t,enabled,JSON.stringify([record]));const paid=await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...origin,cookie:access(r)});assert.equal(paid.status,200);assert.equal(h.state.googleCalls,0);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,8400);assert.equal(h.records()[0].quote.total,84);
 const fresh=await fixture(t,null,{ROUTE_TOLLS_ENABLED:'true'}),q=await fresh.request('/api/quote',trip);assert.equal(q.status,200);assert.equal(q.body.total,80);assert.equal(q.body.tolls.status,'waived');
});

test('Round Trip obtains separate outbound/return estimates and applies FIRST15 only to the original combined fare',async t=>{
 const h=await fixture(t);h.state.routeResult=route=>googleRoute(route.origin.placeId===ids.midtown?250:1375);
 const body={...normal,tripType:'roundtrip',returnDate:'2026-11-12',returnTime:'18:00',promoCode:'FIRST15'},r=await h.request('/api/quote',body);
 assert.equal(r.status,200);assert.equal(h.state.routes.length,2);assert.equal(h.state.routes[0].origin.placeId,ids.newark);assert.equal(h.state.routes[1].origin.placeId,ids.midtown);assert.equal(h.state.routes[1].departureTime,'2026-11-12T23:00:00.000Z');
 assert.deepEqual(r.body.tolls.legs.map(leg=>leg.amountCents),[1375,250]);assert.equal(r.body.tolls.amountCents,1625);assert.equal(r.body.roundTrip.outbound.fare,80);assert.equal(r.body.roundTrip.return.fare,80);assert.equal(r.body.discount,24);assert.equal(r.body.total,152.25);
 const reserved=await h.request('/api/checkout',{...body,paymentChoice:'now',quoteRevision:r.body.quoteRevision});assert.equal(reserved.status,200);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,15225);
});

test('each maintained EWR identity retains eligibility and reverse/foreign destinations cannot inherit the inclusive special',async t=>{
 const ids={general:'ChIJ7wzsxeFSwokRhvLXxTe087M',a:'ChIJ2dQDPZNSwokRVJr9XE2SPt0',b:'ChIJ-6uTxfZSwokR-VfW-WSM53k',c:'ChIJMYEleJSwokRawcDBeH8NVg'};
 for(const [terminal,id]of Object.entries(ids)){
  const h=await fixture(t,null);h.state.detailsById=Object.fromEntries(Object.entries(ids).map(([key,value])=>[value,{id:value,displayName:{text:key==='general'?'Newark Liberty International Airport':'Newark Liberty International Airport Terminal '+key.toUpperCase()},formattedAddress:'3 Brewster Rd, Newark, NJ',types:['airport'],location:{latitude:40.6895,longitude:-74.1745}}]));
  const trip={...booking,vehicle:'suv',pickup:terminal==='general'?'Newark Liberty International Airport (EWR)':'Newark Liberty International Airport Terminal '+terminal.toUpperCase(),pickupPlaceId:id,pickupTerminal:terminal,offerCode:'EWR_MANHATTAN_SUV'};
  const q=await h.request('/api/quote',trip);assert.equal(q.status,200);assert.equal(q.body.total,150);assert.equal(q.body.tolls.status,'included');assert.equal((await h.request('/api/checkout',{...trip,paymentChoice:'later',quoteRevision:q.body.quoteRevision})).status,200);assert.equal(h.records()[0].trip.pickupPlaceId,id);
 }
 for(const change of [{vehicle:'escalade'},{tripType:'roundtrip',returnDate:'2026-11-12',returnTime:'12:00'},{tripType:'hourly',hours:3},{dropoff:'Trenton, NJ'},{dropoff:'Stamford, CT'},{dropoff:'Philadelphia, PA'},{pickup:'Midtown Manhattan, NY',pickupPlaceId:'unapproved',dropoff:'EWR'}]){
  const h=await fixture(t,1375),r=await h.request('/api/quote',{...booking,vehicle:'suv',offerCode:'EWR_MANHATTAN_SUV',...change});assert.equal(r.status,400);assert.equal(h.records().length,0);
 }
});

test('owned EWR special form retries reverify every terminal before revision/deferred shortcuts while keeping the accepted $150 fare and session',async t=>{
 const terminals={general:ids.ewr,a:'ChIJ2dQDPZNSwokRVJr9XE2SPt0',b:'ChIJ-6uTxfZSwokR-VfW-WSM53k',c:'ChIJMYEleJSwokRawcDBeH8NVg'};
 for(const flag of ['false','true'])for(const paymentChoice of ['now','later'])for(const [terminal,id]of Object.entries(terminals)){
  // No real vehicle-rate or congestion-coverage attestation is enabled here.
  const h=await fixture(t,null,{ROUTE_TOLLS_ENABLED:flag});
  h.state.detailsById=Object.fromEntries(Object.entries(terminals).map(([key,value])=>[value,{id:value,displayName:{text:key==='general'?'Newark Liberty International Airport':'Newark Liberty International Airport Terminal '+key.toUpperCase()},formattedAddress:'3 Brewster Rd, Newark, NJ',types:[key==='general'?'airport':'point_of_interest'],location:{latitude:40.6895,longitude:-74.1745}}]));
  h.state.rejectTerminalCDetails=true;
  const trip={...booking,vehicle:'suv',offerCode:'EWR_MANHATTAN_SUV',pickup:terminal==='general'?'Newark Liberty International Airport (EWR)':'Newark Liberty International Airport Terminal '+terminal.toUpperCase(),pickupPlaceId:id,pickupTerminal:terminal},q=await h.request('/api/quote',trip);
  assert.equal(q.status,200);const reserved=await h.request('/api/checkout',{...trip,paymentChoice,quoteRevision:q.body.quoteRevision});assert.equal(reserved.status,200);
  const saved=h.records()[0],routeCount=h.state.routes.length,createCount=h.state.creates.length,providerId=terminal==='c'?ids.ewr:id;
  h.state.routeResult=()=>{throw Error('An accepted fare must not be recalculated.');};
  const calls=h.state.googleCalls;assert.equal((await h.request('/api/checkout',{...trip,paymentChoice},{cookie:''})).status,503);assert.equal(h.state.googleCalls,calls);
  for(const revision of [q.body.quoteRevision,undefined,'0'.repeat(64)]){
   const body={...trip,paymentChoice,...(revision===undefined?{}:{quoteRevision:revision})},detailsBefore=h.state.detailsRequests.length;
   assert.equal((await h.request('/api/checkout',body)).status,200);assert.deepEqual(h.state.detailsRequests.slice(detailsBefore),[providerId]);assert.equal(h.state.routes.length,routeCount);assert.equal(h.state.creates.length,createCount);assert.deepEqual(h.records()[0],saved);
   const proof=h.state.detailsById[providerId];h.state.detailsById[providerId]={...proof,id:'changed_id'};
   assert.equal((await h.request('/api/checkout',body)).status,400);assert.equal(h.state.routes.length,routeCount);assert.equal(h.state.creates.length,createCount);assert.deepEqual(h.records()[0],saved);h.state.detailsById[providerId]=proof;
  }
  assert.equal(saved.quote.totalCents,15000);assert.equal(saved.quote.tolls.status,'included');assert.equal(saved.quote.discount,0);
  if(paymentChoice==='now')assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,15000);
 }
});

test('ordinary EWR pickup/drop-off retries retain their terminal checks and pickup-only Terminal C fallback without repricing',async t=>{
 const c='ChIJMYEleJSwokRawcDBeH8NVg';
 for(const pickup of [true,false]){
  const h=await fixture(t,1375,{}),trip=pickup?{...normal,pickup:'Newark Liberty International Airport Terminal C',pickupPlaceId:c,pickupTerminal:'c'}:{...normal,pickup:normal.dropoff,pickupPlaceId:undefined,dropoff:'Newark Liberty International Airport Terminal C',dropoffPlaceId:c,dropoffTerminal:'c'};
  const providerId=pickup?ids.ewr:c;h.state.detailsById={[providerId]:{id:providerId,displayName:{text:'Newark Liberty International Airport'},formattedAddress:'3 Brewster Rd, Newark, NJ',types:['airport'],location:{latitude:40.6895,longitude:-74.1745}}};
  const reserved=await h.request('/api/checkout',{...trip,paymentChoice:'later'});assert.equal(reserved.status,200);const saved=h.records()[0],routeCount=h.state.routes.length,detailsBefore=h.state.detailsRequests.length;
  h.state.routeResult=()=>{throw Error('No retry repricing.');};assert.equal((await h.request('/api/checkout',{...trip,paymentChoice:'later'})).status,200);assert.deepEqual(h.state.detailsRequests.slice(detailsBefore),[providerId]);assert.equal(h.state.routes.length,routeCount);assert.deepEqual(h.records()[0],saved);
  h.state.detailsById[providerId].id='changed_id';assert.equal((await h.request('/api/checkout',{...trip,paymentChoice:'later'})).status,400);assert.deepEqual(h.records()[0],saved);assert.equal(h.state.creates.length,0);
 }
});

test('unknown tolls, invalid USD money, unsupported currencies and Google failure block both reservation choices without storing or charging',async t=>{
 const cases=[()=>googleRoute(null),()=>({distanceMeters:16093.44,duration:'1200s',travelAdvisory:{tollInfo:{estimatedPrice:[{currencyCode:'EUR',units:'9'}]}}}),()=>({distanceMeters:16093.44,duration:'1200s',travelAdvisory:{tollInfo:{estimatedPrice:[{currencyCode:'USD',units:'-1'}]}}}),()=>{throw Error('private provider failure');}];
 for(const result of cases){const h=await fixture(t);h.state.routeResult=result;
  for(const endpoint of ['/api/quote','/api/checkout'])for(const paymentChoice of ['later','now']){const r=await h.request(endpoint,{...normal,paymentChoice,total:0,tolls:{amountCents:0},tollAmount:0});assert.equal(r.status,422);assert.equal(r.body.error,tolls.REVIEW_MESSAGE);assert.equal(r.body.code,'TOLL_ESTIMATE_UNAVAILABLE');assert.equal(r.body.checkoutAllowed,false);assert.ok(!JSON.stringify(r.body).includes('private provider'));}
  assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
 }
});

test('commercial/pass/congestion settings must be verified; disabled mode keeps legacy requests and fares unchanged',async t=>{
 for(const configured of [undefined,'invalid',JSON.stringify({suv:{emissionType:'GASOLINE',vehicleClass:'2Ax'}}),JSON.stringify({suv:{...profile,commercialRatesVerified:false}}),JSON.stringify({suv:{...profile,congestionCoverageVerified:false}}),JSON.stringify({suv:{...profile,vehicleClass:'commercial_bus'}}),JSON.stringify({suv:{...profile,tollPasses:['invented']}}),JSON.stringify({suv:{...profile,tollPasses:['US_NY_EZPASSNY']}}),JSON.stringify({suv:{...profile,tollPasses:[]}}),JSON.stringify({suv:{...profile,emissionType:'unknown'}})]){
  const h=await fixture(t,1375,{ROUTE_TOLLS_ENABLED:'true',TOLL_VEHICLE_PROFILES_JSON:configured});const r=await h.request('/api/quote',normal);assert.equal(r.status,422);assert.equal(r.body.checkoutAllowed,false);
 }
 const h=await fixture(t,1375,{}),r=await h.request('/api/quote',normal);assert.equal(r.status,200);assert.equal(r.body.total,80);assert.equal(r.body.tolls,undefined);assert.equal(h.state.routes[0].extraComputations,undefined);
 const ny=tolls.vehicleProfile({TOLL_VEHICLE_PROFILES_JSON:JSON.stringify({escalade:{...profile,tollPasses:['US_NY_EZPASSNY'],emissionType:'HYBRID'}})},'escalade');assert.deepEqual(tolls.requestModifiers(ny),{vehicleInfo:{emissionType:'HYBRID'},tollPasses:['US_NY_EZPASSNY']});
});

test('confirmed Suburban NJ E-ZPass business/2Ax facts never imply verified commercial or congestion rates or apply to the Escalade',()=>{
 const env={TOLL_VEHICLE_PROFILES_JSON:JSON.stringify({suv:{emissionType:'GASOLINE'}})},p=tolls.vehicleProfile(env,'suv');
 assert.equal(p.accountType,'business');assert.equal(p.vehicleClass,'2Ax');assert.equal(p.axles,2);assert.deepEqual(p.tollPasses,['US_NJ_EZPASSNJ']);assert.equal(p.verified,false);
 assert.deepEqual(tolls.requestModifiers(p),{vehicleInfo:{emissionType:'GASOLINE'},tollPasses:['US_NJ_EZPASSNJ']});assert.equal(tolls.vehicleProfile(env,'escalade'),null);
 assert.equal(tolls.vehicleProfile({TOLL_VEHICLE_PROFILES_JSON:JSON.stringify({suv:{vehicleClass:'2Ax'}})},'suv'),null);
 const reviewed=tolls.vehicleProfile({TOLL_VEHICLE_PROFILES_JSON:JSON.stringify({suv:{...profile,vehicleClass:'2Ax'}})},'suv');assert.equal(reviewed.verified,true);assert.equal(reviewed.vehicleClass,'2Ax');
});

test('$150 EWR special remains all-inclusive, coupon/surcharge-free and payable despite unknown internal tolls or toll-provider failure',async t=>{
 for(const kind of ['known','unknown','bad_currency','provider_error']){
  const h=await fixture(t);h.state.routeResult=route=>{if(kind==='provider_error'&&route.extraComputations)throw Error('toll feature unavailable');if(kind==='bad_currency')return {distanceMeters:16093.44,duration:'1200s',travelAdvisory:{tollInfo:{estimatedPrice:[{currencyCode:'CAD',units:'99'}]}}};return googleRoute(kind==='unknown'?null:1800);};
  vm.runInContext('pricing.airportSurcharge=30;pricing.lateNightSurcharge=20;pricing.gratuityPercent=20;',h.context);
  const trip={...booking,vehicle:'suv',offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'},q=await h.request('/api/quote',trip);assert.equal(q.status,200);assert.equal(q.body.total,150);assert.equal(q.body.totalCents,15000);assert.equal(q.body.discount,0);assert.equal(q.body.gratuity,0);assert.deepEqual(q.body.surcharges,[]);assert.equal(q.body.tolls.status,'included');assert.equal(q.body.tolls.amountCents,null);assert.equal(q.body.pricingBreakdown.tripFareCents,15000);assert.equal(q.body.pricingBreakdown.tollsCents,null);assert.ok(tolls.validQuote(q.body));
  if(kind!=='known'){assert.equal(q.body.tolls.internalStatus,'unknown');assert.notEqual(q.body.tolls.legs[0]?.amountCents,0);}
  const r=await h.request('/api/checkout',{...trip,quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,15000);
 }
});

test('normal airport pricing retains surcharges/discount/gratuity order, credits an existing toll allowance and never tips or discounts new tolls',async t=>{
 const h=await fixture(t,2000);vm.runInContext('pricing.airportSurcharge=11;pricing.lateNightSurcharge=7;pricing.tollAllowance=4;pricing.gratuityPercent=10;',h.context);
 const q=await h.request('/api/quote',{...normal,pickup:'Newark Liberty International Airport (EWR)',time:'23:30',promoCode:'FIRST15'});assert.equal(q.status,200);assert.equal(q.body.fixedOffer,null);assert.equal(q.body.baseTotal,102);assert.equal(q.body.discount,15.30);assert.equal(q.body.gratuity,8.67);assert.equal(q.body.tolls.estimatedRouteCents,2000);assert.equal(q.body.tolls.allowanceCents,400);assert.equal(q.body.tolls.amountCents,1600);assert.equal(q.body.total,111.37);assert.equal(q.body.originalTotal,128.20);assert.ok(tolls.validQuote(q.body));
 const p=q.body.pricingBreakdown;assert.equal(p.tripFareCents,8400);assert.equal(p.surcharges.reduce((n,item)=>n+item.amountCents,0),1800);assert.equal(p.tollsCents,1600);assert.equal(p.discountCents,1530);assert.equal(p.gratuityCents,867);
});

test('hourly route unknown preserves the exact existing quote, discounts and both payment choices without invented tolls or route calls',async t=>{
 for(const promoCode of ['', 'FIRST15']){
  const trip={...normal,tripType:'hourly',hours:3,promoCode},legacy=await fixture(t,1375,{}),expected=await legacy.request('/api/quote',trip);assert.equal(expected.status,200);assert.equal(expected.body.total,promoCode?331.50:390);
  for(const paymentChoice of ['now','later']){
   const h=await fixture(t,null,{ROUTE_TOLLS_ENABLED:'true'}),q=await h.request('/api/quote',trip);assert.equal(q.status,200);assert.deepEqual(q.body,expected.body);assert.equal(q.body.tolls,undefined);assert.equal(q.body.pricingBreakdown,undefined);
   const reserved=await h.request('/api/checkout',{...trip,paymentChoice,total:1,tollAmount:99999});assert.equal(reserved.status,200);assert.deepEqual(h.records()[0].quote,expected.body);assert.equal(h.state.creates.length,paymentChoice==='later'?0:1);
   const paid=await h.request('/api/booking/'+reserved.body.bookingId+'/checkout',{}, {...origin,cookie:access(reserved)});assert.equal(paid.status,200);assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,Math.round(expected.body.total*100));assert.equal(h.state.routes.length,0);assert.equal(h.state.googleCalls,0);assert.deepEqual(h.records()[0].quote,expected.body);
  }
 }
});

test('Pay Now and Pay Later save the displayed backend total; browser money is ignored and payment completion never recalculates tolls',async t=>{
 for(const choice of ['now','later']){
  const h=await fixture(t,1375),q=await h.request('/api/quote',normal),r=await h.request('/api/checkout',{...normal,paymentChoice:choice,quoteRevision:q.body.quoteRevision,total:1,amount:1,discount:100,tolls:{amountCents:1}});
  assert.equal(r.status,200);const saved=h.records()[0];assert.equal(saved.quote.totalCents,q.body.totalCents);assert.deepEqual(saved.quote.pricingBreakdown,q.body.pricingBreakdown);assert.equal(h.state.creates.length,choice==='later'?0:1);
  h.state.routeResult=()=>{throw Error('future provider unavailable');};const calls=h.state.googleCalls;
  const completed=await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...origin,cookie:access(r)});assert.equal(completed.status,200);assert.equal(h.state.googleCalls,calls);assert.equal(h.records().length,1);assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,9375);
  const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session)).status,200);assert.equal((await h.webhook(session)).status,200);assert.equal(h.records()[0].paymentStatus,'paid');assert.equal(h.records()[0].quote.total,93.75);
 }
});

test('changed displayed quote revision fails before reservation/Stripe; retrying the fresh server quote succeeds',async t=>{
 const h=await fixture(t,500),q=await h.request('/api/quote',normal);h.state.routeResult=()=>googleRoute(650);
 assert.equal((await h.request('/api/checkout',normal)).status,409);assert.equal(h.records().length,0);
 const stale=await h.request('/api/checkout',{...normal,quoteRevision:q.body.quoteRevision});assert.equal(stale.status,409);assert.match(stale.body.error,/quote changed/);assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
 const fresh=await h.request('/api/quote',normal);assert.notEqual(fresh.body.quoteRevision,q.body.quoteRevision);assert.equal((await h.request('/api/checkout',{...normal,quoteRevision:fresh.body.quoteRevision})).status,200);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,8650);
});

test('legacy accepted reservations remain payable across restart without toll fields, repricing, Google calls or new claims',async t=>{
 const legacy=await fixture(t,undefined,{}),r=await legacy.request('/api/checkout',{...normal,paymentChoice:'later'}),before=legacy.records()[0].quote;
 const h=await harness(t,enabled,legacy.data);h.state.routeResult=()=>{throw Error('future routes unavailable');};const result=await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...origin,cookie:access(r)});assert.equal(result.status,200);assert.equal(h.state.googleCalls,0);assert.deepEqual(h.records()[0].quote,before);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,8000);
});

test('a fresh form quote cannot replace an accepted fare: owned retries review the existing reservation before payment',async t=>{
 for(const legacyMode of [true,false])for(const choice of ['later','now']){
  const before=await fixture(t,500,legacyMode?{}:enabled),oldQuote=await before.request('/api/quote',normal),reserved=await before.request('/api/checkout',{...normal,paymentChoice:choice,...(oldQuote.body.quoteRevision?{quoteRevision:oldQuote.body.quoteRevision}:{})}),id=reserved.body.bookingId,accepted=before.records()[0].quote;
  const h=configureLocations(await harness(t,enabled,before.data));h.state.sessions=before.state.sessions;h.state.routeResult=()=>googleRoute(1375);const fresh=await h.request('/api/quote',normal),calls=h.state.googleCalls;
  assert.equal((await h.request('/api/checkout',{...normal,quoteRevision:fresh.body.quoteRevision})).status,503);assert.equal(h.state.creates.length,0);
  for(const revision of [fresh.body.quoteRevision,undefined]){
   const retry=await h.request('/api/checkout',{...normal,...(revision?{quoteRevision:revision}:{})},{cookie:access(reserved)});assert.equal(retry.status,200);assert.equal(retry.body.url,'http://localhost:3000/success.html?booking='+id);assert.equal(h.state.creates.length,0);assert.equal(h.records().length,1);assert.equal(h.state.googleCalls,calls);assert.deepEqual(h.records()[0].quote,accepted);
  }
  const status=await h.request('/api/booking/'+id,undefined,{cookie:access(reserved)});assert.equal(status.body.quote.total,accepted.total);
  assert.equal((await h.request('/api/booking/'+id+'/checkout',{}, {...origin,cookie:access(reserved)})).status,200);assert.equal(h.state.creates.length,choice==='later'?1:0);assert.equal([...h.state.sessions.values()][0].amount_total,Math.round(accepted.total*100));
 }
});

test('JSONB key reordering is deterministic; corrupt toll totals are rejected while legacy records validate unchanged',async t=>{
 const h=await fixture(t),q=await h.request('/api/quote',normal),r=await h.request('/api/checkout',{...normal,paymentChoice:'later',quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);const record=h.records()[0],validate=require('../storage/postgres').validateRecord;
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().reverse().map(key=>[key,reorder(value[key])])):value;
 assert.ok(tolls.validQuote(reorder(record.quote)));assert.ok(validate(reorder(record)));
 for(const mutate of [q=>q.tolls.amountCents++,q=>q.total=1,q=>q.totalCents=1,q=>q.pricingBreakdown.tollsCents=0,q=>q.tolls.legs[0].amountCents=1,q=>q.discountedFare=1,q=>q.tolls.eligibility.dropoffState='NJ',q=>delete q.tolls.eligibility,q=>q.pricingBreakdown.interstate=false]){const changed=structuredClone(record);mutate(changed.quote);assert.equal(tolls.validQuote(changed.quote),false);assert.throws(()=>validate(changed));}
 const legacy=await fixture(t,undefined,{});await legacy.request('/api/checkout',{...normal,paymentChoice:'later'});assert.ok(validate(legacy.records()[0]));
});

test('authenticated owner receipt and guest status expose the same safe breakdown and preserve existing ownership denial',async t=>{
 const h=await fixture(t),account={fullName:'Toll Owner',email:'toll-owner@example.test',phone:'2025550181',password:'Synthetic toll owner password'},a=await h.request('/api/customer/register',account),b=await h.request('/api/customer/register',{...account,email:'toll-other@example.test',phone:'2035550181'}),auth={cookie:cookie(a)};
 const q=await h.request('/api/quote',normal),r=await h.request('/api/checkout',{...normal,paymentChoice:'later',quoteRevision:q.body.quoteRevision},auth),id=r.body.bookingId;
 const owned=await h.request('/api/customer/trips/'+id,undefined,auth);assert.equal(owned.status,200);assert.equal(owned.body.trip.pricingBreakdown.totalCents,9375);assert.equal(owned.body.trip.pricingBreakdown.tollsCents,1375);
 assert.equal((await h.request('/api/customer/trips/'+id,undefined,{cookie:cookie(b)})).status,404);
 const guest=await h.request('/api/booking/'+id,undefined,{cookie:access(r)});assert.equal(guest.body.quote.pricingBreakdown.totalCents,9375);assert.equal(guest.body.quote.total,93.75);assert.ok(!JSON.stringify(guest.body).includes('commercialRatesVerified'));
 const receipt=require('../services/booking-emails').bookingMessage(h.records()[0],'customer_reservation_created',{email:'support@example.test',phone:''});assert.match(receipt.text,/Estimated Interstate Tolls: \$13.75/);assert.match(receipt.text,/Total: \$93.75/);
});

test('Trip Summary uses server cents, shows inclusive $150 without a lower invented fare, and does not display unknown tolls as zero',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),make=()=>({children:[],hidden:false,textContent:'',replaceChildren(){this.children=[];this.textContent='';},append(...items){this.children.push(...items);}}),container=make(),context={document:{getElementById:()=>container,createElement:make},formatMoney:n=>'$'+n.toFixed(2)};
 vm.createContext(context);vm.runInContext(app.slice(app.indexOf('function renderFareBreakdown('),app.indexOf('async function requestQuote(')),context);
 const q={currency:'usd',tolls:{status:'estimated'},pricingBreakdown:{version:1,tripFareCents:8000,surcharges:[],tollsCents:1375,discountCents:0,gratuityCents:0,tollAllowanceCents:0,tollsIncluded:false}};context.renderFareBreakdown(q);assert.equal(container.children[0].children[1].textContent,'$80.00');assert.equal(container.children[1].children[1].textContent,'$13.75');
 context.renderFareBreakdown({...q,pricingBreakdown:{...q.pricingBreakdown,tollScope:'interstate_only',interstate:true}});assert.equal(container.children[1].children[0].textContent,'Estimated Interstate Tolls');
 context.renderFareBreakdown({...q,tolls:{status:'waived'},pricingBreakdown:{...q.pricingBreakdown,tollScope:'interstate_only',interstate:false,tollsCents:0}});assert.equal(container.children[1].children[1].textContent,'No added tolls — same-state trip');
 context.renderFareBreakdown({...q,pricingBreakdown:{...q.pricingBreakdown,tollsCents:0}});assert.equal(container.children[1].children[1].textContent,'No additional charge');
 context.renderFareBreakdown({...q,pricingBreakdown:{...q.pricingBreakdown,tollsIncluded:true,tripFareCents:15000,tollsCents:null}});assert.equal(container.children[0].children[1].textContent,'$150.00');assert.equal(container.children[1].children[1].textContent,'Included');
 context.renderFareBreakdown(null,true);assert.match(container.textContent,/contact us for a final quote/);assert.ok(!container.textContent.includes('$0'));assert.equal(container.hidden,false);
 context.renderFareBreakdown(null);assert.equal(container.hidden,true);
});

test('full refunds use the captured total including accepted tolls and never reprice the cancelled reservation',async t=>{
 const h=await fixture(t,1375),account={fullName:'Toll Refund',email:'toll-refund@example.test',phone:'2025550183',password:'Synthetic toll refund password'},c=cookie(await h.request('/api/customer/register',account)),q=await h.request('/api/quote',normal),r=await h.request('/api/checkout',{...normal,paymentChoice:'later',quoteRevision:q.body.quoteRevision},{cookie:c}),id=r.body.bookingId;
 assert.equal((await h.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c})).status,200);
 const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session)).status,200);
 const before=h.records()[0].quote,trip=(await h.request('/api/customer/trips/'+id,undefined,{cookie:c})).body.trip,calls=h.state.googleCalls;
 h.state.routeResult=()=>{throw Error('no repricing allowed');};
 const cancelled=await h.request('/api/customer/trips/'+id+'/cancel',{expectedPickupAt:trip.management.pickupAt,requestId:crypto.randomUUID(),confirmed:true},{...origin,cookie:c});assert.equal(cancelled.status,200);assert.equal(h.state.googleCalls,calls);assert.equal(h.state.refundRequests.length,1);assert.equal(h.state.refundRequests[0].params.amount,9375);assert.deepEqual(h.records()[0].quote,before);assert.equal(h.records()[0].status,'cancelled');
});

test('PostgreSQL toll snapshots survive JSONB/restart, preserve owner payment amount and roll back corrupt totals',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.ER_TEST_DATABASE_URL);
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !/^er_test_[a-z0-9_]+$/.test(url.pathname.slice(1)))throw Error('Requires an isolated local test database.');
 const {Pool}=require('pg'),schema='er_tolls_'+crypto.randomBytes(10).toString('hex'),admin=new Pool({connectionString:url.toString()}),pool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema}),secondPool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema});
 let schemaCreated=false;
 t.after(async()=>{await pool.end();await secondPool.end();if(schemaCreated)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await admin.query('CREATE SCHEMA '+schema);schemaCreated=true;
 const {createStore}=require('../storage/postgres'),store=createStore({},pool),second=createStore({},secondPool);await store.migrate();
 const h=configureLocations(await harness(t,enabled,'[]',store));h.state.routeResult=()=>googleRoute(1375);
 const account={fullName:'PG Toll Owner',email:'pg-toll-owner@example.test',phone:'2025550185',password:'Synthetic PostgreSQL toll owner'},c=cookie(await h.request('/api/customer/register',account)),q=await h.request('/api/quote',normal),r=await h.request('/api/checkout',{...normal,paymentChoice:'later',quoteRevision:q.body.quoteRevision},{cookie:c}),id=r.body.bookingId;
 assert.equal(r.status,200);const owner=await store.reservationOwner(id),stored=await store.get(id);assert.equal(stored.quote.totalCents,9375);assert.equal(stored.quote.tolls.eligibility.pickupState,'NJ');assert.equal(stored.quote.tolls.eligibility.dropoffState,'NY');assert.ok(tolls.validQuote(stored.quote));
 const restarted=await harness(t,{ROUTE_TOLLS_ENABLED:'true'},'[]',second);restarted.state.routeResult=()=>{throw Error('cannot recalculate accepted tolls');};
 const payment=await restarted.request('/api/customer/trips/'+id+'/payment',{}, {...origin,cookie:c});assert.equal(payment.status,200);assert.equal(restarted.state.googleCalls,0);assert.equal(restarted.state.creates[0].params.line_items[0].price_data.unit_amount,9375);assert.equal(await second.reservationOwner(id),owner);
 await assert.rejects(second.update(id,record=>{record.quote.tolls.amountCents=1;}));assert.equal((await store.get(id)).quote.tolls.amountCents,1375);
 const session=[...restarted.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await restarted.webhook(session)).status,200);assert.equal(Number((await store.capturedPayment(id)).amount_cents),9375);
});
