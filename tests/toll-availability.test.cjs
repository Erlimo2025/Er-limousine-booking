'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create,cases,route}=require('./helpers/booking-browser.cjs');
const legacyIncluded=require('./helpers/legacy-toll-snapshot.cjs');
const tolls=require('../services/route-tolls'),advance=require('../services/advance-toll-estimate');
const backup=require('../services/google-toll-backup');
const origin=h=>({origin:h.url,'sec-fetch-site':'same-origin'});
const access=r=>r.headers.getSetCookie().find(s=>s.includes('er_booking_access_')).split(';')[0];
const privateMarker='private-provider-payload-do-not-log';
const badRoutes=[
 ['provider_amount_unknown',data=>{data.travelAdvisory.tollInfo={};}],
 ['provider_amount_unknown',data=>{data.travelAdvisory.tollInfo.estimatedPrice[0].currencyCode='CAD';}],
 ['provider_toll_evidence_conflict',data=>{delete data.travelAdvisory;}],
 ['geometry_missing',data=>{delete data.legs;}],
 ['geometry_invalid',data=>{data.legs[0].steps[0].polyline.encodedPolyline='!';}],
 ['timing_step_sum_mismatch',data=>{data.staticDuration='1s';}],
 ['crossing_not_matched',data=>{const encode=require('./helpers/official-toll-fixtures.cjs').encode;data.legs=[{steps:[{staticDuration:'1200s',polyline:{encodedPolyline:encode([[-74.2,40.7],[-74.199,40.701]])}}]}];}]
];
for(const [reason,mutate]of badRoutes)test('unverified custom quote without usable Google backup fails closed: '+reason,async t=>{
 const {h,input,c}=await create(t);h.state.routeResult=()=>{const data=route(c,2500);mutate(data);if(backup.canFallback(reason))data.travelAdvisory.tollInfo={};return data;};
 for(const path of ['/api/quote','/api/checkout'])for(const paymentChoice of ['now','later']){
  const r=await h.request(path,{...input,paymentChoice,promoCode:'FIRST15',tolls:{status:'absorbed',amountCents:0},tollReason:'forged',total:1});
  assert.equal(r.status,422);assert.equal(r.body.error,tolls.REVIEW_MESSAGE);assert.equal(r.body.code,'TOLL_ESTIMATE_UNAVAILABLE');assert.equal(r.body.checkoutAllowed,false);assert.equal(r.body.total,undefined);assert.equal(r.body.tollReason,undefined);
 }
 assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);assert.equal(h.testStore.shared.claims.size,0);
 const diagnostics=h.state.logs.filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));assert.equal(diagnostics.length,4);assert.ok(diagnostics.every(line=>line.tollReason===(backup.canFallback(reason)?'provider_amount_unknown':reason)));
 assert.ok(!JSON.stringify(h.state.logs).includes(input.pickup));assert.ok(!JSON.stringify(h.state.logs).includes(input.email));
});
for(const failure of ['http','timeout','invalid_json','fallback','empty','null'])test('Google route '+failure+' cannot fall back to a bookable untolled fare',async t=>{
 const {h,input,c}=await create(t),fetch=h.context.fetch;
 h.context.fetch=async(url,options)=>{
  if(!url.includes('computeRoutes'))return fetch(url,options);
  if(failure==='timeout')throw Object.assign(new Error(privateMarker),{name:'TimeoutError'});
  return {ok:failure!=='http',status:failure==='http'?503:200,json:async()=>{
   if(failure==='invalid_json')throw new SyntaxError(privateMarker);
   if(failure==='null')return null;if(failure==='empty')return {routes:[]};
   return {routes:[route(c,2500)],...(failure==='fallback'?{fallbackInfo:{reason:privateMarker}}:{error:{message:privateMarker}})};
  }};
 };
 for(const path of ['/api/quote','/api/checkout']){const r=await h.request(path,{...input,paymentChoice:'now'});assert.equal(r.status,422);assert.equal(r.body.checkoutAllowed,false);assert.equal(r.body.error,tolls.REVIEW_MESSAGE);assert.ok(!JSON.stringify(r.body).includes(privateMarker));}
 const reason={fallback:'provider_fallback_route',empty:'route_unavailable',null:'provider_response_invalid'}[failure]||'provider_request_failed';
 const diagnostics=h.state.logs.filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));assert.equal(diagnostics.length,2);assert.ok(diagnostics.every(line=>line.tollReason===reason));assert.ok(!h.state.logs.join('').includes(privateMarker));assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
});
for(const choice of ['now','later'])test('repeated quotes preserve cents; a later unavailable estimate blocks '+choice+' before acceptance',async t=>{
 const {h,input,c}=await create(t),first=await h.request('/api/quote',input),again=await h.request('/api/quote',input);
 assert.equal(first.status,200);assert.deepEqual(h.fareTerms(first.body),h.fareTerms(again.body));
 h.state.routeResult=()=>route(c,null);
 assert.equal((await h.request('/api/checkout',{...input,paymentChoice:choice,quoteRevision:first.body.quoteRevision})).status,422);assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);
 h.state.routeResult=()=>route(c,2500);const recovered=await h.request('/api/quote',input);assert.deepEqual(h.fareTerms(recovered.body),h.fareTerms(first.body));
 const accepted=await h.request('/api/checkout',{...input,paymentChoice:choice,quoteRevision:recovered.body.quoteRevision});assert.equal(accepted.status,200);assert.equal(h.records()[0].quote.totalCents,first.body.totalCents);
 const pay=await h.request('/api/booking/'+accepted.body.bookingId+'/checkout',{}, {...origin(h),cookie:access(accepted)});assert.equal(pay.status,200);assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,first.body.totalCents);
});
for(const vehicle of ['suv','escalade'])test('historical company-included '+vehicle+' reservation keeps its accepted fare during provider/configuration failure',async t=>{
 const {h,input}=await create(t),trip={...input,vehicle},q=await h.request('/api/quote',trip),r=await h.request('/api/checkout',{...trip,paymentChoice:'later',quoteRevision:q.body.quoteRevision});assert.equal(r.status,200);
 await h.testStore.update(r.body.bookingId,row=>Object.assign(row,legacyIncluded(row)));const before=structuredClone(h.records()[0].quote);assert.ok(tolls.validQuote(before));assert.equal(before.tolls.status,'absorbed');
 h.state.routeResult=()=>{throw Error(privateMarker);};const calls=h.state.googleCalls;
 for(let i=0;i<2;i++)assert.equal((await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...origin(h),cookie:access(r)})).status,200);
 assert.equal(h.state.googleCalls,calls);assert.deepEqual(h.records()[0].quote,before);assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,before.totalCents);
 const session=[...h.state.sessions.values()][0];session.status='complete';session.payment_status='paid';await h.webhook(session);assert.equal((await h.request('/api/booking/'+r.body.bookingId+'/checkout',{}, {...origin(h),cookie:access(r)})).status,409);
});
test('failure reasons are allowlisted even when an internal error contains private data',()=>{
 assert.equal(advance.failureReason(privateMarker),'estimate_unavailable');assert.equal(tolls.reviewError(privateMarker).tollReason,'estimate_unavailable');
 const e={policy:'interstate_only',pickupState:'NJ',dropoffState:'NY'};
 const result=advance.estimate([],null,e,()=>{throw Error(privateMarker);});assert.equal(result.amountCents,null);assert.ok(!JSON.stringify(result).includes(privateMarker));
});
