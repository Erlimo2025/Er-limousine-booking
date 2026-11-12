'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto');
const pricing=require('../pricing'),tolls=require('../services/route-tolls'),categories=require('../services/toll-pricing-categories');
const {create,cases,route}=require('./helpers/booking-browser.cjs');
const model=()=>structuredClone(pricing),profile=(p,vehicle)=>tolls.customerEstimateProfile(p,{},vehicle);
const access=r=>r.headers.getSetCookie().filter(c=>c.includes('er_booking_access_')).map(c=>c.split(';')[0]).join('; ');
const origin=h=>({origin:h.url,'sec-fetch-site':'same-origin'});
const change=(h,code)=>vm.runInContext(code,h.context);
async function pair(h,input,extra={}){const quotes=[];for(const vehicle of ['suv','escalade']){const q=await h.request('/api/quote',{...input,...extra,vehicle});assert.equal(q.status,200);quotes.push(q.body);}assert.equal(quotes[0].pricingBreakdown.tollsCents,quotes[1].pricingBreakdown.tollsCents);assert.notEqual(quotes[0].pricingBreakdown.tripFareCents,quotes[1].pricingBreakdown.tripFareCents);return quotes;}

test('only category membership is added to each vehicle; all existing fare rates remain unchanged',()=>{
 const withoutCategory=Object.fromEntries(Object.entries(pricing.vehicleRates).map(([key,{tollPricingCategory,...rate}])=>{assert.equal(tollPricingCategory,'luxury_suv');return [key,rate];}));
 assert.deepEqual(withoutCategory,{escalade:{label:'Cadillac Escalade',baseFare:30,perMile:4.5,perMinute:1.25,minimumFare:30,maxPassengers:6,maxLuggage:6,hourlyRate:150},suv:{label:'Black SUV',baseFare:20,perMile:4,perMinute:1,minimumFare:20,maxPassengers:6,hourlyRate:130}});
});
test('both SUVs share an estimate model without certifying individual class, commercial rates or congestion coverage',()=>{
 const env={TOLL_VEHICLE_PROFILES_JSON:JSON.stringify({escalade:{emissionType:'ELECTRIC',tollPasses:['US_NY_EZPASSNY'],commercialRatesVerified:true,congestionCoverageVerified:true}})};
 const suv=tolls.customerEstimateProfile(pricing,env,'suv'),escalade=tolls.customerEstimateProfile(pricing,env,'escalade');assert.deepEqual(suv,escalade);assert.ok(tolls.advanceEligible(suv));assert.equal(suv.verified,false);assert.equal(suv.commercialRatesVerified,false);assert.equal(suv.congestionCoverageVerified,false);assert.equal(suv.customerEstimate.actualVehicleEligibilityVerified,false);assert.equal(suv.customerEstimate.companyAbsorbsDifferences,true);assert.equal(suv.official,undefined);assert.equal(suv.estimate,undefined);assert.equal(suv.vehicleClass,undefined);
 assert.deepEqual(tolls.requestModifiers(suv),{vehicleInfo:{emissionType:'GASOLINE'},tollPasses:['US_NJ_EZPASSNJ']});suv.tollPasses[0]='modified';assert.equal(profile(pricing,'escalade').tollPasses[0],'US_NJ_EZPASSNJ');
});
test('future configured Luxury SUV members reuse the category without adding tariff code or inheriting vehicle evidence',()=>{
 const p=model();for(const vehicle of ['navigator','future_luxury_suv']){p.vehicleRates[vehicle]={label:'Future configured vehicle',tollPricingCategory:'luxury_suv'};assert.deepEqual(profile(p,vehicle),profile(p,'suv'));}
 assert.equal(profile(p,'not_configured'),null);assert.equal(profile(p,'__proto__'),null);
 p.vehicleRates.navigator.tollPricingCategory='unreviewed_category';assert.equal(profile(p,'navigator'),null);
});
test('invalid assigned categories fail closed instead of borrowing a per-vehicle estimate profile',()=>{
 const legacy={emissionType:'GASOLINE',tollPasses:['US_NJ_EZPASSNJ'],estimate2026:{paClass1Eligible:true,axles:2,singleRearWheels:true,noTrailer:true,mtaPlan:'standard_daily',tlcLicensed:false,crossingCreditEligible:true}};
 for(const patch of [{operatorApprovedEstimate:false},{policy:'future_unreviewed'},{portAuthorityTariffClass:'3'},{companyAbsorbsDifferences:false},{tollPasses:['US_NY_EZPASSNY']},{emissionType:'unknown'},{crossingCreditAssumption:null},{actualVehicleEligibilityVerified:true},{commercialRatesVerified:true},{congestionCoverageVerified:true}]){
  const p=model();Object.assign(p.tollPricingCategories.luxury_suv,patch);for(const vehicle of ['suv','escalade'])assert.equal(tolls.customerEstimateProfile(p,{TOLL_VEHICLE_PROFILES_JSON:JSON.stringify({[vehicle]:legacy})},vehicle),null);
 }
 const p=model();delete p.tollPricingCategories;assert.equal(profile(p,'suv'),null);
});
for(const [label,date,time,amount]of [['weekday off-peak','2026-11-10','12:00',2079],['weekday peak','2026-11-10','08:00',2279],['weekend off-peak','2026-11-07','10:00',2079],['weekend peak','2026-11-07','12:00',2279],['overnight','2026-11-10','22:00',1704]])test('same route and '+label+' produce equal modeled tolls and different trip fares',async t=>{
 const {h,input,c}=await create(t);h.context.process.env.TOLL_VEHICLE_PROFILES_JSON=undefined;h.state.routeResult=()=>route(c,0);const [suv,escalade]=await pair(h,input,{date,time});assert.equal(suv.pricingBreakdown.tollsCents,amount);assert.equal(escalade.pricingBreakdown.tollsCents,amount);assert.deepEqual(h.state.routes[0],h.state.routes[1]);
});
test('selected Holland/GWB routes and reverse direction use the same model for both SUVs',async t=>{
 for(const c of [{...cases[0],crossing:'holland',street:'CANAL ST'}, {...cases[0],crossing:'gwb'},cases.find(c=>c.id==='reverse')]){const {h,input}=await create(t,c),q=await pair(h,input);assert.equal(q[0].tolls.status,'estimated');assert.deepEqual(h.state.routes[0],h.state.routes[1]);}
});
test('tolls are route-dependent amounts, not a fixed SUV surcharge or a sum of duplicate totals',async t=>{
 const {h,input,c}=await create(t);for(const amount of [3000,4500]){h.state.routeResult=()=>route(c,amount);const q=await pair(h,input);assert.equal(q[0].pricingBreakdown.tollsCents,amount);assert.equal(q[1].pricingBreakdown.tollsCents,amount);}
});
test('same-state, round trips and hourly preserve their separate existing pricing behavior',async t=>{
 const same=await create(t,cases.find(c=>c.id==='same_state'));for(const q of await pair(same.h,same.input)){assert.equal(q.tolls.status,'waived');assert.equal(q.pricingBreakdown.tollsCents,0);}assert.ok(same.h.state.routes.every(r=>!r.extraComputations));
 const round=await create(t,cases.find(c=>c.id==='round_trip'));const q=await pair(round.h,round.input);assert.equal(round.h.state.routes.length,4);assert.equal(q[0].pricingBreakdown.tollsCents,2725);assert.notDeepEqual(round.h.state.routes[0].origin,round.h.state.routes[1].origin);
 const hourly=await create(t,cases.find(c=>c.id==='hourly'));for(const [vehicle,total]of [['suv',455],['escalade',525]]){const q=await hourly.h.request('/api/quote',{...hourly.input,vehicle});assert.equal(q.status,200);assert.equal(q.body.total,total);assert.equal(q.body.tolls,undefined);}assert.equal(hourly.h.state.routes.length,0);
});
for(const reason of ['missing_category','unknown_provider','unknown_future_provider','ambiguous_geometry'])test(reason+' requires review for both SUVs',async t=>{
 const {h,input,c}=await create(t);if(reason==='missing_category')change(h,'delete pricing.tollPricingCategories.luxury_suv;');
 if(['unknown_provider','unknown_future_provider'].includes(reason))h.state.routeResult=()=>route(c,null);if(reason==='ambiguous_geometry')h.state.routeResult=()=>({distanceMeters:100000,duration:'1500s'});
 for(const vehicle of ['suv','escalade'])for(const endpoint of ['/api/quote','/api/checkout']){const q=await h.request(endpoint,{...input,vehicle,...(reason==='unknown_future_provider'?{date:'2027-01-10'}:{}),paymentChoice:'later'});assert.equal(q.status,422);assert.equal(q.body.code,'TOLL_ESTIMATE_UNAVAILABLE');assert.equal(q.body.checkoutAllowed,false);}assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);if(reason==='missing_category')assert.equal(h.state.routes.length,0);
});
test('request JSON cannot choose a category, tariff, pass, amount, vehicle certification or outside-coverage fallback',async t=>{
 const {h,input}=await create(t),normal=await h.request('/api/quote',input),forged=await h.request('/api/quote',{...input,tollPricingCategory:'free',tollPricingCategories:{luxury_suv:{companyAbsorbsDifferences:false}},emissionType:'ELECTRIC',tollPasses:['forged'],total:1,tolls:{amountCents:1},actualVehicleEligibilityVerified:true});assert.equal(forged.status,200);assert.deepEqual(h.fareTerms(forged.body),h.fareTerms(normal.body));
 assert.equal((await h.request('/api/quote',{...input,vehicle:'not_configured',tollPricingCategory:'luxury_suv'})).status,400);
 for(const vehicle of ['suv','escalade'])assert.equal((await h.request('/api/quote',{...input,vehicle,dropoff:'Stamford, CT'})).status,422);assert.equal(h.records().length,0);
});
test('EWR special is still exactly $150 for Suburban and cannot be inherited by Escalade',async t=>{
 const {h,input}=await create(t,cases.find(c=>c.id==='ewr_special'));
 const request={...input,offerCode:'EWR_MANHATTAN_SUV',promoCode:'FIRST15'};const special=await h.request('/api/quote',{...request,vehicle:'suv'});assert.equal(special.status,200);assert.equal(special.body.totalCents,15000);assert.equal(special.body.discount,0);assert.equal(special.body.tolls.status,'included');
 for(const endpoint of ['/api/quote','/api/checkout'])assert.equal((await h.request(endpoint,{...request,vehicle:'escalade',paymentChoice:'later'})).status,400);assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
});
test('FIRST15 changes only each vehicle fare while the shared toll is unchanged',async t=>{
 const {h,input}=await create(t);const q=await pair(h,input,{promoCode:'FIRST15'});for(const item of q){assert.equal(item.promotion.percentOff,15);assert.equal(item.discount,Math.round(item.baseTotal*15)/100);assert.equal(item.pricingBreakdown.tollsCents,2500);assert.equal(item.totalCents,Math.round(item.discountedFare*100)+2500);}
});
for(const vehicle of ['suv','escalade'])for(const choice of ['now','later'])for(const fallback of [false,true])test(vehicle+' '+choice+' '+(fallback?'included':'estimate')+' matches the saved/Checkout cents and retains immutable payment retries',async t=>{
 const {h,input}=await create(t,fallback?cases.find(c=>c.id==='unknown'):cases[0]);const trip={...input,vehicle},q=await h.request('/api/quote',trip);
 if(fallback){assert.equal(q.status,422);assert.equal((await h.request('/api/checkout',{...trip,paymentChoice:choice,total:1})).status,422);assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);return;}
 const r=await h.request('/api/checkout',{...trip,paymentChoice:choice,quoteRevision:q.body.quoteRevision,total:1});assert.equal(r.status,200);const record=h.records()[0];assert.ok(tolls.validQuote(record.quote));assert.equal(record.quote.totalCents,q.body.totalCents);assert.equal(record.quote.tolls.pricingCategory.id,'luxury_suv');assert.equal(record.quote.tolls.pricingCategory.actualVehicleEligibilityVerified,false);assert.equal(record.quote.tolls.pricingCategory.companyAbsorbsDifferences,true);assert.equal(h.state.creates.length,choice==='later'?0:1);
 const before=h.state.googleCalls;change(h,'delete pricing.tollPricingCategories;');h.state.routeResult=()=>{throw Error('Accepted quote cannot be repriced');};for(let i=0;i<2;i++)assert.equal((await h.request('/api/booking/'+record.id+'/checkout',{}, {...origin(h),cookie:access(r)})).status,200);assert.equal(h.state.googleCalls,before);assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,q.body.totalCents);
 const tampered=structuredClone(record.quote);tampered.tolls.pricingCategory.actualVehicleEligibilityVerified=true;assert.equal(tolls.validQuote(tampered),false);const repriced=structuredClone(record.quote);repriced.tolls.pricingCategory.crossingCreditAssumption='none';assert.equal(tolls.validQuote(repriced),false);
 const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';assert.equal((await h.webhook(session)).status,200);assert.equal((await h.request('/api/booking/'+record.id+'/checkout',{}, {...origin(h),cookie:access(r)})).status,409);assert.equal(h.state.creates.length,1);
});
test('category-model changes require a new quote before any reservation or Checkout',async t=>{
 const {h,input}=await create(t),q=await h.request('/api/quote',input);change(h,"pricing.tollPricingCategories.luxury_suv.emissionType='HYBRID';");assert.equal((await h.request('/api/checkout',{...input,paymentChoice:'now',quoteRevision:q.body.quoteRevision})).status,409);assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);const updated=await h.request('/api/quote',input);assert.notEqual(updated.body.quoteRevision,q.body.quoteRevision);
});
test('a category configured without crossing credits applies that assumption equally without certification',async t=>{
 const {h,input,c}=await create(t);change(h,"pricing.tollPricingCategories.luxury_suv.crossingCreditAssumption='none';");h.state.routeResult=()=>route(c,0);for(const q of await pair(h,input))assert.equal(q.pricingBreakdown.tollsCents,2379);
});
test('previously accepted per-vehicle estimates remain payable after switching to the shared category',async t=>{
 const {h,input}=await create(t);change(h,'delete pricing.vehicleRates.suv.tollPricingCategory;');const q=await h.request('/api/quote',input),r=await h.request('/api/checkout',{...input,paymentChoice:'later',quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);const before=h.records()[0].quote;assert.equal(before.tolls.pricingCategory,undefined);assert.ok(tolls.validQuote(before));change(h,"pricing.vehicleRates.suv.tollPricingCategory='luxury_suv';delete pricing.tollPricingCategories;");h.state.routeResult=()=>{throw Error('No repricing');};assert.equal((await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...origin(h),cookie:access(r)})).status,200);assert.deepEqual(h.records()[0].quote,before);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,q.body.totalCents);
});
test('disabled customer charging preserves each vehicle fare without requesting toll estimates',async t=>{
 const {h,input}=await create(t,cases.find(c=>c.id==='flag_off'));for(const [vehicle,total]of [['suv',293.55],['escalade',340.87]]){const q=await h.request('/api/quote',{...input,vehicle});assert.equal(q.status,200);assert.equal(q.body.total,total);assert.equal(q.body.tolls,undefined);}assert.ok(h.state.routes.every(r=>!r.extraComputations));
});
test('strict verified mode does not accept the shared estimate as actual vehicle evidence',async t=>{
 // Mode is captured at startup. Use the existing verified fixture and its
 // known provider locations, so denial cannot be caused by a missing address.
 const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),file=path.join(__dirname,'tolls.test.cjs'),source=fs.readFileSync(file,'utf8');const {fixture,normal}=new Function('require','__dirname',source.slice(0,source.indexOf("test('provider Money"))+'\nreturn {fixture,normal};')(createRequire(file),__dirname);
 const strict=await fixture(t,2500,{ROUTE_TOLLS_ENABLED:'true',ROUTE_TOLLS_MODE:'verified',TOLL_VEHICLE_PROFILES_JSON:undefined});assert.equal((await strict.request('/api/quote',normal)).status,422);assert.equal(strict.records().length,0);assert.equal(strict.state.creates.length,0);assert.equal(strict.state.routes.length,0);
});
test('PostgreSQL shared-category snapshots survive JSONB/restart and keep both SUV payment amounts immutable',{skip:!process.env.ER_TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.ER_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/er_test_[a-z0-9_]+$/);const {Pool}=require('pg'),schema='er_shared_suv_'+crypto.randomBytes(8).toString('hex'),admin=new Pool({connectionString:url.toString()}),pool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema}),otherPool=new Pool({connectionString:url.toString(),options:'-c search_path='+schema});let created=false;
 t.after(async()=>{await pool.end();await otherPool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});await admin.query('CREATE SCHEMA '+schema);created=true;const {createStore}=require('../storage/postgres'),store=createStore({},pool),second=createStore({},otherPool);await store.migrate();
 for(const vehicle of ['suv','escalade']){const {h,input}=await create(t,cases[0],store),trip={...input,vehicle,email:'pg-shared-'+vehicle+'@example.test'},q=await h.request('/api/quote',trip),r=await h.request('/api/checkout',{...trip,paymentChoice:'later',quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);const saved=await second.get(r.body.bookingId);assert.ok(tolls.validQuote(saved.quote));assert.equal(saved.quote.tolls.pricingCategory.actualVehicleEligibilityVerified,false);
  const restarted=await create(t,{...cases[0],disabled:true},second);change(restarted.h,'delete pricing.tollPricingCategories;');const paid=await restarted.h.request('/api/booking/'+saved.id+'/checkout',{}, {...origin(restarted.h),cookie:access(r)});assert.equal(paid.status,200);assert.equal(restarted.h.state.googleCalls,0);assert.equal(restarted.h.state.creates[0].params.line_items[0].price_data.unit_amount,q.body.totalCents);await assert.rejects(second.update(saved.id,row=>{row.quote.tolls.pricingCategory.actualVehicleEligibilityVerified=true;}));assert.deepEqual((await store.get(saved.id)).quote,saved.quote);
 }
});
