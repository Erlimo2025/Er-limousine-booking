const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const advance=require('../services/advance-toll-estimate'),tolls=require('../services/route-tolls'),geo=require('../services/toll-route-evidence'),official=require('./helpers/official-toll-fixtures.cjs');
const reference=require('../services/data/toll-estimate-reference-2026.json');
const file=path.join(__dirname,'tolls.test.cjs'),source=fs.readFileSync(file,'utf8'),cut=source.indexOf("test('provider Money");
const {fixture,normal,origin,access,place,harness,configureLocations}=new Function('require','__dirname',source.slice(0,cut)+'\nreturn {fixture,normal,origin,access,place,harness,configureLocations};')(createRequire(file),__dirname);
// Operator assumptions below are synthetic tests, NOT verified ER fleet facts.
const profile={emissionType:'GASOLINE',tollPasses:['US_NJ_EZPASSNJ'],commercialRatesVerified:false,congestionCoverageVerified:false,
 estimate2026:{paClass1Eligible:true,axles:2,singleRearWheels:true,noTrailer:true,mtaPlan:'standard_daily',tlcLicensed:false,crossingCreditEligible:true}};
const env={ROUTE_TOLLS_ENABLED:'true',ROUTE_TOLLS_MODE:'estimate',TOLL_VEHICLE_PROFILES_JSON:JSON.stringify({suv:profile})};
// Synthetic provider paths follow public source points for detector controls.
// Added joins/intermediate points are synthetic, not real Google route evidence.
function route(id='lincoln',direction='ny_bound',google=2500,midtown=false){
 const f=reference.crossings.find(f=>f.id===id),raw=[...f.nj.flat(),...f.ny.flat()].sort((a,b)=>a[0]-b[0]);
 let points=raw.filter((p,i)=>!i||geo.distance(raw[i-1],p)>1);
 if(midtown){const target=midtown==='unknown'?[[-73.98,40.775],[-73.98,40.774]]:reference.crzStreetWitnesses.filter(s=>s.name==='E  42 ST').flatMap(w=>w.paths.flat()).sort((a,b)=>a[0]-b[0]);
  const end=points.at(-1),start=target[0];for(let i=1;i<=8;i++)points.push([end[0]+(start[0]-end[0])*i/8,end[1]+(start[1]-end[1])*i/8]);points.push(...target);
 }
 if(direction==='nj_bound')points.reverse();
 const seconds=1200/(points.length-1);
 return {distanceMeters:100000,duration:'1500s',staticDuration:'1200s',legs:[{steps:points.slice(1).map((p,i)=>({staticDuration:seconds.toFixed(6)+'s',polyline:{encodedPolyline:official.encode([points[i],p])}}))}],
  travelAdvisory:{tollInfo:google===null?{}:{estimatedPrice:[{currencyCode:'USD',units:String(Math.floor(google/100)),nanos:google%100*10000000}]}}};
}
const eligibility={policy:'interstate_only',pickupState:'NJ',dropoffState:'NY',pickupCounty:null,dropoffCounty:'New York County',pickupPlaceId:'nj',dropoffPlaceId:'ny'};
function estimate(data,departure='2026-11-10T17:00:00Z',e=eligibility,p=tolls.vehicleProfile(env,'suv')){
 return advance.estimate([{data,origin:e.pickupPlaceId,destination:e.dropoffPlaceId,departure}],p,e,tolls.routeTolls);
}

for(const id of ['lincoln','holland','gwb'])test('estimate identifies source-backed '+id+' geometry; official subtotal and Google aggregate are not added',()=>{
 const q=estimate(route(id,'ny_bound',2500,id==='gwb'));assert.equal(q.status,'estimated',q.reviewReason);assert.equal(q.legs[0].crossing,id);
 assert.equal(q.legs[0].paCents,1479);assert.equal(q.legs[0].congestionCents,900);assert.equal(q.legs[0].creditCents,id==='gwb'?0:300);
 assert.equal(q.amountCents,2500);assert.ok(advance.valid(q));
 const floor=estimate(route(id,'ny_bound',100,id==='gwb'));assert.equal(floor.amountCents,id==='gwb'?2379:2079);
});

test('official weekday/weekend periods and bounded crossing time choose the applicable upper estimate',()=>{
 for(const [departure,pa,mta,credit]of [['2026-11-10T13:00:00Z',1679,900,300],['2026-11-07T15:00:00Z',1479,900,300],['2026-11-07T17:00:00Z',1679,900,300],['2026-11-11T03:00:00Z',1479,225,0]]){
  const q=estimate(route('lincoln','ny_bound',0),departure);assert.equal(q.status,'estimated');assert.equal(q.legs[0].paCents,pa);assert.equal(q.legs[0].congestionCents,mta);assert.equal(q.legs[0].creditCents,credit);
 }
});

test('NJ-bound direction has zero PA component and never inherits NY-bound credits',()=>{
 const e={...eligibility,pickupState:'NY',dropoffState:'NJ',pickupCounty:'New York County',dropoffCounty:null};
 const q=estimate(route('gwb','nj_bound',225),'2026-11-10T17:00:00Z',e);assert.equal(q.status,'estimated');assert.equal(q.legs[0].paCents,0);assert.equal(q.legs[0].creditCents,0);assert.equal(q.amountCents,225);
});

test('isolated crossings of city streets from an excluded-road-like path cannot be accumulated into a CRZ entry',()=>{
 const lines=[40.750,40.755,40.760].map(lat=>[[-74,lat],[-73.99,lat]]),points=[];
 for(let i=0;i<50;i++)points.push({point:[-73.995,40.748+i*.0003],meters:33,order:i,segment:i});
 assert.equal(advance.streetWitness(points,lines),null);
 const local=[];for(let i=0;i<12;i++)local.push({point:[-73.999+i*.0004,40.75],meters:34,order:i,segment:i});assert.ok(advance.streetWitness(local,lines));
});

test('a reverse route with an unproved starting zone includes unknown congestion rather than assuming no charge',()=>{
 const e={...eligibility,pickupState:'NY',dropoffState:'NJ',pickupCounty:'New York County',dropoffCounty:null};
 assert.equal(estimate(route('lincoln','nj_bound',225),'2026-11-10T17:00:00Z',e).status,'absorbed');
});

test('missing class, unknown price, unknown CRZ, invalid money, missing geometry and unsupported years use included tolls without false zero estimates',()=>{
 const bad=route();bad.travelAdvisory.tollInfo.estimatedPrice[0].currencyCode='CAD';
 for(const [data,time,p]of [[route(),undefined,null],[route('lincoln','ny_bound',null)],[route('gwb','ny_bound',2500,'unknown')],[bad],[{distanceMeters:100,duration:'1s'}],[route(),'2027-01-10T17:00:00Z']]){
  const q=estimate(data,time,eligibility,p===null?null:tolls.vehicleProfile(env,'suv'));assert.equal(q.status,'absorbed');assert.equal(q.estimatedRouteCents,null);assert.equal(q.amountCents,0);assert.equal(q.policy,advance.FALLBACK);
 }
});

test('approved service scope uses provider county facts for all five NYC boroughs, not NY state or browser labels alone',()=>{
 for(const county of ['New York County','Kings County','Queens County','Bronx County','Richmond County'])assert.ok(advance.covered({state:'NJ'},{state:'NY',county}));
 for(const county of ['Albany County',null,undefined])assert.equal(advance.covered({state:'NJ'},{state:'NY',county}),false);
 assert.equal(advance.covered({state:'CT'},{state:'NJ'}),false);
});

for(const choice of ['now','later'])for(const available of [true,false])test('HTTP '+choice+' '+(available?'estimate':'included fallback')+' binds final cents, reuses Checkout and never reprices accepted payment',async t=>{
 const h=await fixture(t,2500,available?env:{...env,TOLL_VEHICLE_PROFILES_JSON:undefined});h.state.routeResult=()=>route();
 const q=await h.request('/api/quote',{...normal,tollAmount:1,tollPolicy:'forged',vehicleClass:'1'});assert.equal(q.status,200);
 assert.equal(q.body.tolls.status,available?'estimated':'absorbed');assert.equal(q.body.pricingBreakdown.tollsCents,available?2500:0);
 if(!available)assert.ok(h.state.routes.every(r=>!r.extraComputations));
 assert.equal(q.body.tolls.legs,undefined);assert.ok(!JSON.stringify(q.body).includes('paCents'));
 const reserved=await h.request('/api/checkout',{...normal,paymentChoice:choice,quoteRevision:q.body.quoteRevision,total:1,tolls:{amountCents:1}});assert.equal(reserved.status,200);
 const saved=h.records()[0];assert.ok(tolls.validQuote(saved.quote));assert.equal(saved.quote.totalCents,q.body.totalCents);assert.equal(h.state.creates.length,choice==='now'?1:0);
 const calls=h.state.googleCalls;h.state.routeResult=()=>{throw Error('Must not recalculate accepted booking');};
 for(let i=0;i<2;i++)assert.equal((await h.request('/api/booking/'+reserved.body.bookingId+'/checkout',{}, {...origin,cookie:access(reserved)})).status,200);
 assert.equal(h.state.googleCalls,calls);assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,q.body.totalCents);
 assert.equal(h.records()[0].paymentStatus,'unpaid');
 const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session)).status,200);assert.equal(h.records()[0].paymentStatus,'paid');
 assert.equal((await h.request('/api/booking/'+reserved.body.bookingId+'/checkout',{}, {...origin,cookie:access(reserved)})).status,409);assert.equal(h.state.creates.length,1);
 const receipt=require('../services/booking-emails').bookingMessage(saved,'customer_reservation_created',{email:'support@example.test',phone:''});assert.doesNotMatch(receipt.text,/Port Authority crossing|MTA congestion|Eligible credit/);assert.match(receipt.text,available?/Tolls: \$25.00/:/Tolls: Included/);
 const corrupt=structuredClone(saved.quote);corrupt.tolls.amountCents++;assert.equal(tolls.validQuote(corrupt),false);
});

test('outside coverage and unverified provider jurisdiction require review before reservation or Checkout',async t=>{
 const h=await fixture(t,2500,env);
 const albany=place('NY','ChIJ_mock_albany','Albany, NY');albany.addressComponents.find(c=>c.types.includes('administrative_area_level_2')).longText='Albany County';h.state.searchResults['Albany, NY']=[albany];
 for(const dropoff of ['Stamford, CT','Philadelphia, PA','Albany, NY'])for(const endpoint of ['/api/quote','/api/checkout']){
  const r=await h.request(endpoint,{...normal,dropoff,paymentChoice:'later',dropoffState:'NY',dropoffCounty:'New York County'});assert.equal(r.status,422);assert.equal(r.body.checkoutAllowed,false);
 }
 assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
});

test('all five provider-verified NYC boroughs can book with company-included unknown tolls',async t=>{
 const h=await fixture(t,null,{...env,TOLL_VEHICLE_PROFILES_JSON:undefined});
 for(const county of ['New York County','Kings County','Queens County','Bronx County','Richmond County']){
  const destination=place('NY','ChIJ_mock_'+county.replaceAll(' ','_'),county);destination.addressComponents.find(c=>c.types.includes('administrative_area_level_2')).longText=county;h.state.searchResults[county]=[destination];
  const q=await h.request('/api/quote',{...normal,dropoff:county});assert.equal(q.status,200);assert.equal(q.body.tolls.status,'absorbed');assert.equal(q.body.pricingBreakdown.tollsCents,0);
 }
});

test('same-state trips waive additional tolls and hourly behavior and the $150 offer are unchanged',async t=>{
 const h=await fixture(t,null,{...env,TOLL_VEHICLE_PROFILES_JSON:undefined});
 const same=await h.request('/api/quote',{...normal,dropoff:'Trenton, NJ'});assert.equal(same.status,200);assert.equal(same.body.tolls.status,'waived');assert.equal(same.body.tolls.amountCents,0);
 const hourly=await h.request('/api/quote',{...normal,tripType:'hourly',hours:3});assert.equal(hourly.status,200);assert.equal(hourly.body.tolls,undefined);
 const special=await h.request('/api/quote',{...normal,pickup:'EWR',offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'});assert.equal(special.status,200);assert.equal(special.body.totalCents,15000);assert.equal(special.body.tolls.status,'included');assert.equal(special.body.discount,0);
});

test('round trips price each direction separately, share only an assumed booking-day ledger, and preserve FIRST15 order',async t=>{
 const h=await fixture(t,2500,env);h.state.routeResult=r=>route('lincoln',r.origin.placeId.includes('midtown')?'nj_bound':'ny_bound',r.origin.placeId.includes('midtown')?0:2500,r.origin.placeId.includes('midtown'));
 const q=await h.request('/api/quote',{...normal,tripType:'roundtrip',returnDate:'2026-11-10',returnTime:'18:00',promoCode:'FIRST15'});assert.equal(q.status,200);assert.equal(h.state.routes.length,2);assert.equal(q.body.discount,Math.round(q.body.baseTotal*15)/100);assert.equal(q.body.pricingBreakdown.tollsCents,2500);assert.equal(q.body.totalCents,q.body.pricingBreakdown.totalCents);
});

test('uncertain Google congestion overlap on same-day round-trip legs uses included tolls instead of a possible duplicate charge',async t=>{
 const h=await fixture(t,2500,env);h.state.routeResult=r=>route('lincoln',r.origin.placeId.includes('midtown')?'nj_bound':'ny_bound',r.origin.placeId.includes('midtown')?900:2500,r.origin.placeId.includes('midtown'));
 const q=await h.request('/api/quote',{...normal,tripType:'roundtrip',returnDate:'2026-11-10',returnTime:'18:00'});assert.equal(q.status,200);assert.equal(q.body.tolls.status,'absorbed');assert.equal(q.body.pricingBreakdown.tollsCents,0);
});

test('transient toll-provider failure retries only the base route and preserves bookable included-tolls fare',async t=>{
 const h=await fixture(t,2500,env);h.state.routeResult=r=>{if(r.extraComputations)throw Error('Mock toll request unavailable');return route();};
 const q=await h.request('/api/quote',normal);assert.equal(q.status,200);assert.equal(q.body.tolls.status,'absorbed');assert.equal(h.state.routes.length,2);assert.equal(q.body.pricingBreakdown.tollsCents,0);
 assert.equal((await h.request('/api/checkout',{...normal,paymentChoice:'later',quoteRevision:q.body.quoteRevision})).status,200);assert.equal(h.state.creates.length,0);
});

test('a changed advance estimate requires reviewing the new quote before reservation or payment',async t=>{
 const h=await fixture(t,2500,env);h.state.routeResult=()=>route();const q=await h.request('/api/quote',normal);h.state.routeResult=()=>route('lincoln','ny_bound',3500);
 const r=await h.request('/api/checkout',{...normal,paymentChoice:'now',quoteRevision:q.body.quoteRevision});assert.equal(r.status,409);assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
});

test('harmless geometry resampling does not invalidate an unchanged advance price',async t=>{
 const h=await fixture(t,2500,env);h.state.routeResult=()=>route();const q=await h.request('/api/quote',normal);
 h.state.routeResult=()=>{const data=route(),points=geo.geometry(data).points,steps=[];for(let i=1;i<points.length;i++){
  const m=points[i-1].map((n,j)=>(n+points[i][j])/2),duration=(1200/(points.length-1)/2).toFixed(6)+'s';
  steps.push({staticDuration:duration,polyline:{encodedPolyline:official.encode([points[i-1],m])}},{staticDuration:duration,polyline:{encodedPolyline:official.encode([m,points[i]])}});
 }data.legs[0].steps=steps;return data;};
 const r=await h.request('/api/checkout',{...normal,paymentChoice:'later',quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);assert.equal(h.records()[0].quote.totalCents,q.body.totalCents);assert.equal(h.records()[0].quote.quoteRevision,q.body.quoteRevision);
});

test('PostgreSQL advance and included-tolls snapshots survive restart without repricing or new evidence',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.ER_TEST_DATABASE_URL);if(url.hostname!=='127.0.0.1'||!/^er_test_[a-z0-9_]+$/.test(url.pathname.slice(1)))throw Error('Requires an isolated localhost test database');
 const {Pool}=require('pg'),crypto=require('node:crypto'),schema='er_advance_'+crypto.randomBytes(10).toString('hex'),admin=new Pool({connectionString:url.toString()}),pool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema}),secondPool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema});let created=false;
 t.after(async()=>{await pool.end();await secondPool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await admin.query('CREATE SCHEMA '+schema);created=true;const {createStore}=require('../storage/postgres'),store=createStore({},pool),second=createStore({},secondPool);await store.migrate();
 for(const available of [true,false]){
  const h=configureLocations(await harness(t,available?env:{...env,TOLL_VEHICLE_PROFILES_JSON:undefined},'[]',store));h.state.routeResult=()=>route();
  const trip={...normal,email:'pg-advance-'+available+'@example.test'},q=await h.request('/api/quote',trip),r=await h.request('/api/checkout',{...trip,paymentChoice:'later',quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);
  const record=await second.get(r.body.bookingId);assert.equal(record.quote.tolls.status,available?'estimated':'absorbed');assert.ok(tolls.validQuote(record.quote));assert.equal(record.quote.totalCents,q.body.totalCents);
  const restarted=await harness(t,{ROUTE_TOLLS_ENABLED:'false'},'[]',second);restarted.state.routeResult=()=>{throw Error('No repricing');};
  const pay=await restarted.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...origin,cookie:access(r)});assert.equal(pay.status,200);assert.equal(restarted.state.googleCalls,0);assert.equal(restarted.state.creates[0].params.line_items[0].price_data.unit_amount,q.body.totalCents);
  await assert.rejects(second.update(record.id,row=>{row.quote.tolls.amountCents++;}));assert.equal((await store.get(record.id)).quote.totalCents,q.body.totalCents);
 }
});

module.exports={route,profile,env};
