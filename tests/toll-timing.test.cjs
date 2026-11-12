'use strict';
// Provider-shaped synthetic responses, not captured customer routes or fleet proof.
const test=require('node:test'),assert=require('node:assert/strict');
const geo=require('../services/toll-route-evidence'),advance=require('../services/advance-toll-estimate'),tolls=require('../services/route-tolls'),rates=require('../services/official-toll-rates');
const {route,create,cases}=require('./helpers/booking-browser.cjs'),pricing=require('../pricing');
const c={crossing:'lincoln',direction:'ny_bound',street:'W  42 ST'};
const e={policy:'interstate_only',pickupState:'NJ',dropoffState:'NY',pickupCounty:null,dropoffCounty:'New York County',pickupPlaceId:'synthetic_nj',dropoffPlaceId:'synthetic_ny'};
const profile=tolls.customerEstimateProfile(pricing,{},'suv');
const estimate=(data,departure='2026-11-10T17:00:00.000Z')=>advance.estimate([{data,origin:e.pickupPlaceId,destination:e.dropoffPlaceId,departure}],profile,e,tolls.routeTolls);

test('consistent complete timing keeps the original step bounds and estimate',()=>{
 const data=route(c,2500),g=geo.geometry(data);assert.equal(g.timingBasis,'provider_step_bounds');assert.equal(g.traffic,300);assert.ok(g.segments.some(s=>s.start>0));assert.equal(estimate(data).amountCents,2500);
});
for(const timing of ['faster_traffic','rounded_steps'])test(timing+' uses a whole-provider-route envelope without invented per-step times',()=>{
 const data=route({...c,timing},2500),g=geo.geometry(data),normal=geo.geometry(route(c,2500));
 assert.equal(g.timingBasis,'provider_route_bounds');assert.equal(g.traffic,0);assert.equal(g.hash,normal.hash);
 const end=Math.max(Number(data.duration.slice(0,-1)),Number(data.staticDuration.slice(0,-1)),data.legs[0].steps.reduce((n,s)=>n+Number(s.staticDuration.slice(0,-1)),0));
 assert.ok(g.segments.every(s=>s.start===0&&s.end===end));
 for(let i=0;i<3;i++){const q=estimate(data);assert.equal(q.status,'estimated');assert.equal(q.amountCents,2500);assert.equal(q.legs[0].paCents,1479);assert.equal(q.legs[0].creditCents,300);assert.ok(advance.valid(q));}
});
test('rounding tolerance follows reported precision and rejects a mismatch beyond that budget',()=>{
 const rounded=route({...c,timing:'rounded_steps'},2500);assert.ok(Math.abs(Number(rounded.staticDuration.slice(0,-1))-rounded.legs[0].steps.reduce((n,s)=>n+Number(s.staticDuration.slice(0,-1)),0))>1);assert.doesNotThrow(()=>geo.geometry(rounded));
 const precise=route(c,2500);precise.staticDuration='1198s';assert.throws(()=>geo.geometry(precise),error=>error.reason==='timing_step_sum_mismatch');
});
test('truncated whole-second steps use a resolution bound rather than assuming nearest rounding',()=>{
 const data=route(c,2500),steps=data.legs[0].steps;for(const step of steps)step.staticDuration='5s';
 data.staticDuration=(steps.length*5.9).toFixed(1)+'s';data.duration='1800s';
 const difference=Number(data.staticDuration.slice(0,-1))-steps.length*5;assert.ok(difference>steps.length/2);assert.ok(difference<steps.length+1);
 const g=geo.geometry(data);assert.equal(g.timingBasis,'provider_route_bounds');assert.ok(g.segments.every(s=>s.start===0&&s.end===1800));assert.equal(estimate(data).amountCents,2500);
});
for(const value of [undefined,null,'NaNs','-1s','0s'])test('invalid route static timing remains blocked: '+String(value),()=>{
 const data=route(c,2500);data.staticDuration=value;const q=estimate(data);assert.equal(q.status,'unknown');assert.equal(q.amountCents,null);assert.equal(q.reviewReason,'timing_static_invalid');
});
for(const value of [undefined,null,'NaNs','-1s','0s'])test('invalid route traffic timing remains blocked: '+String(value),()=>{
 const data=route(c,2500);data.duration=value;const q=estimate(data);assert.equal(q.status,'unknown');assert.equal(q.amountCents,null);assert.equal(q.reviewReason,'timing_travel_invalid');
});
for(const kind of ['static','travel','steps'])test('six-hour timing bound remains enforced: '+kind,()=>{
 const data=route(c,2500);if(kind==='static')data.staticDuration='21601s';if(kind==='travel')data.duration='21601s';if(kind==='steps')for(const s of data.legs[0].steps)s.staticDuration='100s';
 assert.throws(()=>geo.geometry(data),error=>error.reason==='timing_route_limit');
});
test('grossly contradictory and missing step durations are not synthesized or waived',()=>{
 const gross=route(c,2500);gross.staticDuration='1s';assert.equal(estimate(gross).reviewReason,'timing_step_sum_mismatch');
 const missing=route(c,2500);delete missing.legs[0].steps[1].staticDuration;assert.equal(estimate(missing).reviewReason,'timing_missing');
});
test('a wider crossing window retains the higher published boundary rate and refuses a calendar-day ambiguity',()=>{
 const data=route({...c,timing:'faster_traffic'},0),q=estimate(data,'2026-11-10T14:55:00.000Z');assert.equal(q.status,'estimated');assert.equal(q.legs[0].paCents,1679);assert.equal(q.legs[0].congestionCents,900);assert.equal(q.legs[0].creditCents,300);assert.equal(q.amountCents,2279);
 assert.equal(estimate(data,'2026-11-11T04:50:00.000Z').reviewReason,'day_boundary_uncertain');
 const f=require('./helpers/official-toll-fixtures.cjs'),p={official:f.profile().official2026};assert.throws(()=>rates.rateWindow(geo.windowAt(geo.geometry(data),0,'2026-11-10T14:55:00.000Z',p),'pa'),rates.TollReviewError);
});
test('whole-route timing cannot invent peak congestion credit across an MTA period boundary',()=>{
 for(const departure of ['2026-11-10T09:55:00.000Z','2026-11-11T01:50:00.000Z']){
  const q=estimate(route({...c,timing:'faster_traffic'},2500),departure);assert.equal(q.status,'unknown');assert.equal(q.amountCents,null);assert.equal(q.reviewReason,'credit_period_uncertain');
 }
});

for(const timing of ['faster_traffic','rounded_steps'])for(const vehicle of ['suv','escalade'])for(const choice of ['now','later'])test(timing+' '+vehicle+' '+choice+' matches quote, stored fare and Checkout without double counting',async t=>{
 const fixture={...cases[0],id:'timing_'+timing,timing}, {h,input}=await create(t,fixture),trip={...input,vehicle};
 const q=await h.request('/api/quote',trip),again=await h.request('/api/quote',trip);assert.equal(q.status,200);assert.deepEqual(h.fareTerms(q.body),h.fareTerms(again.body));assert.equal(q.body.pricingBreakdown.tollsCents,2500);
 const accepted=await h.request('/api/checkout',{...trip,paymentChoice:choice,quoteRevision:q.body.quoteRevision});assert.equal(accepted.status,200);assert.equal(h.records()[0].quote.totalCents,q.body.totalCents);assert.ok(tolls.validQuote(h.records()[0].quote));
 const cookie=accepted.headers.getSetCookie().find(s=>s.includes('er_booking_access_')).split(';')[0],before=h.state.googleCalls;h.state.routeResult=()=>{throw Error('No repricing of accepted test fare');};
 for(let i=0;i<2;i++)assert.equal((await h.request('/api/booking/'+accepted.body.bookingId+'/checkout',{}, {origin:h.url,'sec-fetch-site':'same-origin',cookie})).status,200);
 assert.equal(h.state.googleCalls,before);assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,q.body.totalCents);
});
for(const reason of ['money','geometry','provider','tariff_date','calendar_day'])test('recovered timing cannot bypass other toll verification: '+reason,async t=>{
 const {h,input}=await create(t,{...cases[0],id:'blocked_'+reason,timing:'faster_traffic'}),original=h.state.routeResult;
 h.state.routeResult=r=>{if(reason==='provider')throw Error('Synthetic provider failure');const data=original(r);if(['money','geometry','tariff_date','calendar_day'].includes(reason))data.travelAdvisory.tollInfo={};if(reason==='geometry')delete data.legs;return data;};
 const trip={...input,...(reason==='tariff_date'?{date:'2027-01-10'}:{}),...(reason==='calendar_day'?{time:'23:50'}:{})};
 for(const path of ['/api/quote','/api/checkout']){const r=await h.request(path,{...trip,paymentChoice:'later'});assert.equal(r.status,422);assert.equal(r.body.code,'TOLL_ESTIMATE_UNAVAILABLE');assert.equal(r.body.checkoutAllowed,false);}
 assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
});
