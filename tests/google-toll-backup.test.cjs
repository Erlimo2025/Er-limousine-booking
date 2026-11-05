'use strict';
// All prices, crossing labels and provider routes below are synthetic controls.
// No actual Google route, commercial classification or E-ZPass bill is certified.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
const tolls=require('../services/route-tolls'),backup=require('../services/google-toll-backup'),advance=require('../services/advance-toll-estimate'),pricing=require('../pricing');
const {create,cases,route}=require('./helpers/booking-browser.cjs');
const profile=tolls.customerEstimateProfile(pricing,{},'suv');
const eligibility={policy:'interstate_only',pickupState:'NJ',dropoffState:'NY',pickupCounty:null,dropoffCounty:'Queens County',pickupPlaceId:'synthetic_nj',dropoffPlaceId:'synthetic_jfk'};
const fixture=()=>cases.find(c=>c.id==='jfk_unmatched');
const money=cents=>({currencyCode:'USD',units:String(Math.floor(cents/100)),nanos:cents%100*10000000});
const data=(cents=2113)=>({distanceMeters:60000,duration:'3600s',travelAdvisory:{tollInfo:{estimatedPrice:[money(cents)]}}});
const selected=(d=data(),departure='2026-11-10T17:00:00.000Z',reverse=false)=>({data:d,origin:reverse?eligibility.dropoffPlaceId:eligibility.pickupPlaceId,destination:reverse?eligibility.pickupPlaceId:eligibility.dropoffPlaceId,departure});
const price=(routes=[selected()],p=profile,e=eligibility)=>tolls.priceAdvanceRoutes(routes,p,e);
const origin=h=>({origin:h.url,'sec-fetch-site':'same-origin'});
const access=r=>r.headers.getSetCookie().find(c=>c.includes('er_booking_access_')).split(';')[0];

test('custom remains primary and its complete quote is unchanged when it succeeds',()=>{
 const c=cases[0],e={...eligibility,dropoffCounty:'New York County'},routes=[selected(route(c,100))];
 const primary=advance.estimate(routes,profile,e,tolls.routeTolls),q=price(routes,profile,e);
 assert.equal(primary.status,'estimated');assert.equal(q.format,'advance_estimate_2026');assert.deepEqual(q,primary);assert.equal(q.amountCents,q.legs[0].officialSubtotalCents);
 assert.notEqual(q.amountCents,q.legs[0].googleRouteCents+q.legs[0].officialSubtotalCents);
});

for(const label of ['Goethals Bridge','Bayonne Bridge','Outerbridge Crossing','Verrazzano Bridge','Lincoln Tunnel','Holland Tunnel','George Washington Bridge'])test('synthetic Google-only '+label+' route does not require or invent custom crossing recognition',()=>{
 const d=data();d.description='Synthetic route via '+label;const q=price([selected(d)]);
 assert.equal(q.format,backup.FORMAT);assert.equal(q.amountCents,2113);assert.equal(q.primaryReviewReason,'geometry_missing');assert.ok(backup.valid(q));
 assert.equal(q.legs[0].crossing,undefined);assert.equal(q.legs[0].paCents,undefined);assert.equal(q.legs[0].congestionCents,undefined);assert.equal(q.legs[0].creditCents,undefined);
 assert.equal(q.googleAssumptions.commercialRatesVerified,false);assert.equal(q.pricingCategory.actualVehicleEligibilityVerified,false);
});

for(const reason of ['crossing_not_matched','crossing_ambiguous','direction_conflict','geometry_invalid','geometry_disconnected','timing_static_invalid','timing_step_sum_mismatch','timing_unavailable','unsupported_tariff_date','day_boundary_uncertain','congestion_entry_unknown','reverse_congestion_entry_unknown','credit_period_uncertain'])test('valid Google aggregate can back up custom '+reason,()=>{
 const q=backup.estimate([selected()],profile,eligibility,tolls.routeTolls,reason);assert.equal(q.status,'estimated');assert.equal(q.amountCents,2113);assert.ok(backup.valid(q));
});
for(const reason of ['provider_request_failed','provider_fallback_route','provider_toll_evidence_conflict','vehicle_estimate_profile_missing','location_unverified','service_coverage_unverified','route_unavailable','route_time_order','estimate_unavailable'])test('backup cannot bypass '+reason,()=>{
 assert.equal(backup.canFallback(reason),false);let calls=0;
 const q=backup.estimate([selected()],profile,eligibility,()=>{calls++;return {status:'estimated',amountCents:2113};},reason);
 assert.equal(q.status,'unknown');assert.equal(q.amountCents,null);assert.equal(calls,0);
});

const invalidPrices=[undefined,null,[],[null],[{}],[{currencyCode:'CAD',units:'20'}],[{currencyCode:'USD',units:'-1'}],
 [{currencyCode:'USD',units:'1.5'}],[{currencyCode:'USD',units:21}],[{currencyCode:'USD',units:'01'}],
 [{currencyCode:'USD',units:'20',nanos:-1}],[{currencyCode:'USD',nanos:1000000000}],[{currencyCode:'USD',nanos:'1'}],
 [money(2113),money(2113)],[{currencyCode:'USD',units:'999999999999999999999'}]];
for(const [index,prices]of invalidPrices.entries())test('missing, malformed, negative or ambiguous Google Money is denied / '+index,()=>{
 const d=data();d.travelAdvisory.tollInfo.estimatedPrice=prices;const q=price([selected(d)]);
 assert.equal(q.status,'unknown');assert.equal(q.amountCents,null);assert.equal(q.reviewReason,'provider_amount_unknown');
});
test('missing advisory and leg-only data are not reliable route-level zero estimates',()=>{
 for(const change of [d=>delete d.travelAdvisory,d=>d.travelAdvisory={},d=>{delete d.travelAdvisory;d.legs=[{travelAdvisory:{tollInfo:{estimatedPrice:[money(2113)]}}}];}]){
  const d=data();change(d);assert.equal(price([selected(d)]).status,'unknown');
 }
});
test('protobuf zero values and fractional-cent rounding use the existing integer-cent parser',()=>{
 const d=data();d.travelAdvisory.tollInfo.estimatedPrice=[{currencyCode:'USD'}];assert.equal(price([selected(d)]).amountCents,0);
 d.travelAdvisory.tollInfo.estimatedPrice=[{currencyCode:'USD',units:'1',nanos:125000000}];assert.equal(price([selected(d)]).amountCents,113);
});
test('route and leg totals are never added together',()=>{
 const d=data();d.legs=[{travelAdvisory:{tollInfo:{estimatedPrice:[money(2113)]}}}];const q=price([selected(d)]);assert.equal(q.amountCents,2113);assert.equal(q.legs.length,1);
});

for(const fault of ['origin','destination','metrics','duration','departure','provider_fallback'])test('selected route/request association remains required / '+fault,()=>{
 const r=selected();if(fault==='origin')r.origin='foreign_origin';if(fault==='destination')r.destination='foreign_destination';if(fault==='metrics')r.data.distanceMeters=NaN;
 if(fault==='duration')r.data.duration='NaNs';if(fault==='departure')r.departure='not_a_time';if(fault==='provider_fallback')r.data.unusableForTolls=true;
 const q=price([r]);assert.equal(q.status,'unknown');assert.equal(q.amountCents,null);
});
test('missing vehicle or pass configuration cannot be replaced with browser or Google prices',()=>{
 for(const p of [null,{}, {...profile,tollPasses:['US_NY_EZPASSNY']}, {...profile,customerEstimate:{...profile.customerEstimate,actualVehicleEligibilityVerified:true}}])assert.equal(price([selected()],p).status,'unknown');
 assert.equal(price([selected()],profile,{...eligibility,dropoffCounty:'Albany County'}).status,'unknown');
});

test('return routes are independent, and different-day Google aggregates are summed once',()=>{
 const q=price([selected(data(2113)),selected(data(625),'2026-11-11T23:00:00.000Z',true)]);
 assert.equal(q.status,'estimated');assert.equal(q.amountCents,2738);assert.deepEqual(q.legs.map(l=>l.amountCents),[2113,625]);assert.ok(backup.valid(q));
});
test('ambiguous same-day positive Google aggregates require review; explicit zero is not a second daily charge',()=>{
 const q=price([selected(),selected(data(625),'2026-11-10T23:00:00.000Z',true)]);assert.equal(q.status,'unknown');assert.equal(q.reviewReason,'daily_provider_overlap_unknown');
 const zero=price([selected(),selected(data(0),'2026-11-10T23:00:00.000Z',true)]);assert.equal(zero.status,'estimated');assert.equal(zero.amountCents,2113);assert.ok(backup.valid(zero));
});
test('New York day intervals, midnight and return ordering are checked independently of custom geometry',()=>{
 const crossingMidnight=price([selected(data(),'2026-11-11T04:30:00.000Z'),selected(data(625),'2026-11-11T17:00:00.000Z',true)]);
 assert.equal(crossingMidnight.status,'unknown');assert.equal(crossingMidnight.reviewReason,'daily_provider_overlap_unknown');
 const tooEarly=price([selected(),selected(data(625),'2026-11-10T17:15:00.000Z',true)]);assert.equal(tooEarly.status,'unknown');assert.equal(tooEarly.reviewReason,'route_time_order');
});
test('peak/off-peak and congestion differences from Google are accepted as whole-route estimates without invented components',()=>{
 for(const [departure,amount]of [['2026-11-10T13:00:00.000Z',2421],['2026-11-11T03:00:00.000Z',1711]]){
  const q=price([selected(data(amount),departure)]);assert.equal(q.amountCents,amount);assert.ok(backup.valid(q));assert.equal(q.legs[0].congestionCents,undefined);
 }
});

const routeCases=[
 ['South Orange NJ to JFK','south_orange_jfk'],['South Orange NJ to Times Square','south_orange_times_square'],
 ['Jersey City NJ to JFK','jersey_city_jfk'],['Union City NJ to JFK','union_city_jfk'],['NJ to Brooklyn','nj_brooklyn'],
 ['NJ to Manhattan','interstate_estimate'],['Manhattan to NJ','reverse'],['JFK to NJ','jfk_reverse']
];
for(const [label,id]of routeCases)for(const choice of ['now','later'])test('mocked '+label+' / '+choice+' keeps selected metrics, stored fare and Stripe total consistent',async t=>{
 const c=cases.find(c=>c.id===id),{h,input}=await create(t,c),q=await h.request('/api/quote',input);assert.equal(q.status,200);assert.equal(q.body.tolls.status,'estimated');
 assert.equal(h.state.routes.length,1);const provider=h.state.routeResult(h.state.routes[0]);assert.equal(q.body.miles,Math.round(provider.distanceMeters/1609.344*100)/100);assert.equal(q.body.minutes,Math.round(Number(provider.duration.slice(0,-1))/60));
 assert.equal(q.body.pricingBreakdown.totalCents,q.body.totalCents);assert.equal(q.body.tolls.legs,undefined);assert.equal(q.body.tolls.googleAssumptions,undefined);
 const before=h.state.routes.length,r=await h.request('/api/checkout',{...input,paymentChoice:choice,quoteRevision:q.body.quoteRevision,amount:1,tolls:{amountCents:1},crossing:'forged'});
 assert.equal(r.status,200);assert.equal(h.state.routes.length-before,1);assert.equal(h.records().length,1);const saved=h.records()[0];assert.equal(saved.quote.totalCents,q.body.totalCents);assert.ok(tolls.validQuote(saved.quote));
 if(c.expectedSource)assert.equal(saved.quote.tolls.format,c.expectedSource);
 const calls=h.state.googleCalls;h.state.routeResult=()=>{throw Error('No repricing of an accepted booking');};
 for(let i=0;i<2;i++)assert.equal((await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...origin(h),cookie:access(r)})).status,200);
 assert.equal(h.state.googleCalls,calls);assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,q.body.totalCents);
 assert.equal(saved.paymentStatus,'unpaid');const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session)).status,200);
 assert.equal(h.records()[0].paymentStatus,'paid');assert.equal((await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...origin(h),cookie:access(r)})).status,409);
 const receipt=require('../services/booking-emails').bookingMessage(h.records()[0],'customer_reservation_created',{email:'support@example.test',phone:''});
 assert.match(receipt.text,/Tolls: \$/);assert.doesNotMatch(receipt.text,/google_routes_backup|primaryReviewReason|googleAssumptions|geometryHash/);
});

test('backup quotes remain stable across custom diagnostic changes, but a new amount requires quoteRevision approval',async t=>{
 const c=fixture(),{h,input}=await create(t,c),first=await h.request('/api/quote',input);
 h.state.routeResult=()=>route({...c,crossingEvidence:'multiple'},2500);const same=await h.request('/api/quote',input);assert.equal(same.body.quoteRevision,first.body.quoteRevision);
 h.state.routeResult=()=>route(c,2600);assert.equal((await h.request('/api/checkout',{...input,paymentChoice:'now',quoteRevision:first.body.quoteRevision})).status,409);assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
});
test('Google alternatives do not replace the selected route or contribute their tolls',async t=>{
 const c=fixture(),{h,input}=await create(t,c),fetch=h.context.fetch;
 h.context.fetch=async(url,options)=>url.includes('computeRoutes')?{ok:true,status:200,json:async()=>({routes:[route(c,2113),{...route(c,9900),distanceMeters:200000}]})}:fetch(url,options);
 const q=await h.request('/api/quote',input);assert.equal(q.status,200);assert.equal(q.body.pricingBreakdown.tollsCents,2113);assert.equal(q.body.miles,62.14);
});
test('an HTTP 200 body carrying a provider error cannot supply a backup price',async t=>{
 const c=fixture(),{h,input}=await create(t,c),fetch=h.context.fetch;
 h.context.fetch=async(url,options)=>url.includes('computeRoutes')?{ok:true,status:200,json:async()=>({routes:[route(c,2113)],error:{message:'private-provider-error-marker'}})}:fetch(url,options);
 for(const endpoint of ['/api/quote','/api/checkout']){
  const r=await h.request(endpoint,{...input,paymentChoice:'later'});assert.equal(r.status,422);assert.equal(r.body.checkoutAllowed,false);
 }
 assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);assert.ok(!JSON.stringify(h.state.logs).includes('private-provider-error-marker'));
});
test('FIRST15 discounts the existing fare, never the Google toll estimate, and SUVs retain individual fares',async t=>{
 const quotes=[];for(const vehicle of ['suv','escalade']){
  const {h,input}=await create(t,fixture()),q=await h.request('/api/quote',{...input,vehicle,promoCode:'FIRST15'});assert.equal(q.status,200);assert.equal(q.body.promotion.percentOff,15);
  assert.equal(q.body.pricingBreakdown.tollsCents,2500);assert.equal(q.body.discount,Math.round(q.body.baseTotal*15)/100);assert.equal(q.body.totalCents,Math.round(q.body.discountedFare*100)+Math.round(q.body.gratuity*100)+2500);quotes.push(q.body);
 }assert.notEqual(quotes[0].baseTotal,quotes[1].baseTotal);assert.equal(quotes[0].pricingBreakdown.tollsCents,quotes[1].pricingBreakdown.tollsCents);
});
test('an unavailable future custom tariff uses a valid scheduled Google estimate without inventing future official rates',async t=>{
 for(const vehicle of ['suv','escalade']){
  const {h,input}=await create(t,cases[0]),trip={...input,vehicle,date:'2027-01-10'},q=await h.request('/api/quote',trip);
  assert.equal(q.status,200);assert.equal(q.body.pricingBreakdown.tollsCents,2500);assert.match(h.state.routes[0].departureTime,/^2027-01-10T/);
  const r=await h.request('/api/checkout',{...trip,paymentChoice:'later',quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);
  assert.equal(h.records()[0].quote.tolls.format,backup.FORMAT);assert.equal(h.records()[0].quote.tolls.primaryReviewReason,'unsupported_tariff_date');
 }
});
test('fallback snapshot validation rejects altered prices, assumptions, route association, extra components and private reasons',async t=>{
 const {h,input}=await create(t,fixture()),q=await h.request('/api/quote',input),r=await h.request('/api/checkout',{...input,paymentChoice:'later',quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);
 const original=h.records()[0].quote;for(const change of [q=>q.tolls.amountCents++,q=>q.tolls.legs[0].googleRouteCents++,q=>q.tolls.legs[0].routeHash='0'.repeat(64),q=>q.tolls.eligibility.dropoffPlaceId='foreign_place',
  q=>q.tolls.googleAssumptions.commercialRatesVerified=true,q=>q.tolls.pricingCategory.actualVehicleEligibilityVerified=true,q=>q.tolls.legs[0].congestionCents=900,q=>q.tolls.primaryReviewReason='private-provider-payload']){
  const copy=structuredClone(original);change(copy);assert.equal(tolls.validQuote(copy),false);
 }assert.ok(tolls.validQuote(original));
});
test('refunds and cancellation use the captured Google-backed total without repricing or allowing another payment',async t=>{
 const {h,input}=await create(t,fixture()),account={fullName:'Google Refund',email:'google-refund@example.test',phone:'2025550189',password:'Synthetic Google refund password'};
 const registration=await h.request('/api/customer/register',account),cookie=registration.headers.getSetCookie().find(s=>s.includes('er_customer_session')).split(';')[0],auth={cookie};
 const trip={...input,email:account.email,phone:account.phone},q=await h.request('/api/quote',trip,auth),r=await h.request('/api/checkout',{...trip,paymentChoice:'later',quoteRevision:q.body.quoteRevision},auth);assert.equal(r.status,200);
 const id=r.body.bookingId;assert.equal((await h.request('/api/customer/trips/'+id+'/payment',{}, {...origin(h),cookie})).status,200);
 const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session)).status,200);
 const before=structuredClone(h.records()[0].quote),detail=(await h.request('/api/customer/trips/'+id,undefined,auth)).body.trip,calls=h.state.googleCalls;
 h.state.routeResult=()=>{throw Error('No repricing during cancellation or refund');};
 const body={expectedPickupAt:detail.management.pickupAt,requestId:crypto.randomUUID(),confirmed:true};
 for(let i=0;i<2;i++)assert.equal((await h.request('/api/customer/trips/'+id+'/cancel',body,{...origin(h),cookie})).status,200);
 assert.equal(h.state.googleCalls,calls);assert.equal(h.state.refundRequests.length,1);assert.equal(h.state.refundRequests[0].params.amount,q.body.totalCents);assert.deepEqual(h.records()[0].quote,before);
 assert.equal((await h.request('/api/customer/trips/'+id+'/payment',{}, {...origin(h),cookie})).status,409);assert.equal(h.state.creates.length,1);
});

test('PostgreSQL Google backup survives JSONB/restart, validates rollback and preserves frozen Checkout amounts',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.ER_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/er_test_[a-z0-9_]+$/);
 const {Pool}=require('pg'),schema='er_google_backup_'+crypto.randomBytes(8).toString('hex'),admin=new Pool({connectionString:url.toString()}),pool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema}),otherPool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema});let created=false;
 t.after(async()=>{await pool.end();await otherPool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await admin.query('CREATE SCHEMA '+schema);created=true;const {createStore}=require('../storage/postgres'),store=createStore({},pool),second=createStore({},otherPool);await store.migrate();
 for(const vehicle of ['suv','escalade']){
  const {h,input}=await create(t,fixture(),store),trip={...input,vehicle,email:'pg-google-'+vehicle+'@example.test'},q=await h.request('/api/quote',trip),r=await h.request('/api/checkout',{...trip,paymentChoice:'later',quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);
  const saved=await second.get(r.body.bookingId);assert.equal(saved.quote.tolls.format,backup.FORMAT);assert.ok(tolls.validQuote(saved.quote));
  const restarted=await create(t,{...fixture(),disabled:true},second);vm.runInContext('delete pricing.tollPricingCategories;',restarted.h.context);
  assert.equal((await restarted.h.request('/api/booking/'+saved.id+'/checkout',{}, {...origin(restarted.h),cookie:access(r)})).status,200);assert.equal(restarted.h.state.googleCalls,0);assert.equal(restarted.h.state.creates[0].params.line_items[0].price_data.unit_amount,q.body.totalCents);
  await assert.rejects(second.update(saved.id,row=>{row.quote.tolls.legs[0].routeHash='0'.repeat(64);}));assert.deepEqual((await store.get(saved.id)).quote,saved.quote);
 }
});
