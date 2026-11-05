'use strict';
// Synthetic provider controls using the existing public reference points and
// explicitly synthetic joins. These are not captured JFK routes or fleet proof.
const test=require('node:test'),assert=require('node:assert/strict');
const advance=require('../services/advance-toll-estimate'),geo=require('../services/toll-route-evidence'),tolls=require('../services/route-tolls');
const reference=require('../services/data/toll-estimate-reference-2026.json');
const {route,create,cases}=require('./helpers/booking-browser.cjs');
const mockTollCents=2500,fixture=id=>cases.find(c=>c.id===id);
const origin=h=>({origin:h.url,'sec-fetch-site':'same-origin'});

test('the reference inventory supports three Manhattan crossings and does not certify additional JFK crossings',()=>{
 assert.deepEqual(reference.crossings.map(c=>c.id),['lincoln','holland','gwb']);
 assert.equal(reference.notVerifiedCommercialCoverage,true);
 for(const id of ['goethals','bayonne','outerbridge'])assert.equal(reference.crossings.some(c=>c.id===id),false);
});

for(const crossing of ['lincoln','holland','gwb'])for(const direction of ['ny_bound','nj_bound'])test('source-backed synthetic '+crossing+' control identifies one crossing in '+direction+' direction',()=>{
 const g=geo.geometry(route({crossing,direction,street:''},mockTollCents)),evidence=advance.crossingEvidence(g),detected=advance.detect(g);
 assert.equal(evidence.matches.length,1);assert.equal(detected.gate.crossing,crossing);assert.equal(detected.gate.direction,direction);
 assert.deepEqual(detected.gate,evidence.matches[0]);
});

for(const [id,count,reason]of [['jfk_unmatched',0,'crossing_not_matched'],['jfk_ambiguous',2,'crossing_ambiguous']])test('synthetic '+id+' distinguishes '+count+' supported matches and cannot choose an arbitrary facility',()=>{
 const data=route(fixture(id),mockTollCents),g=geo.geometry(data),evidence=advance.crossingEvidence(g);
 assert.equal(evidence.matches.length,count);
 if(count)assert.deepEqual(evidence.matches.map(m=>m.crossing),['lincoln','holland']);
 assert.throws(()=>advance.detect(g),error=>error.reason===reason);
 assert.equal(advance.failureReason(reason),reason);
});

test('unsupported crossing names or provider labels cannot replace missing geometry evidence',()=>{
 for(const name of ['Goethals Bridge','Bayonne Bridge','Outerbridge Crossing','Lincoln Tunnel']){
  const data=route(fixture('jfk_unmatched'),mockTollCents);data.description=name;
  for(const step of data.legs[0].steps)step.navigationInstruction={instructions:'Use '+name};
  assert.equal(advance.crossingEvidence(geo.geometry(data)).matches.length,0);
  assert.throws(()=>advance.detect(geo.geometry(data)),error=>error.reason==='crossing_not_matched');
 }
});

for(const id of ['jfk_lincoln','jfk_holland'])for(const choice of ['now','later'])test('synthetic Queens/JFK booking '+id+' '+choice+' preserves authoritative cents, ownership and payment retries',async t=>{
 const {h,input}=await create(t,fixture(id)),q=await h.request('/api/quote',input);
 assert.equal(q.status,200);assert.equal(q.body.tolls.status,'estimated');assert.equal(q.body.pricingBreakdown.tollsCents,mockTollCents);
 assert.equal(q.body.pricingBreakdown.totalCents,q.body.totalCents);
 assert.equal(q.body.tolls.legs,undefined);assert.doesNotMatch(JSON.stringify(q.body),/encodedPolyline|geometryHash|crossingMatchCount/);
 const repeat=await h.request('/api/quote',input);assert.deepEqual(repeat.body,q.body);
 const accepted=await h.request('/api/checkout',{...input,paymentChoice:choice,quoteRevision:q.body.quoteRevision,total:1,tolls:{amountCents:1}});
 assert.equal(accepted.status,200);assert.equal(h.records().length,1);assert.equal(h.records()[0].quote.totalCents,q.body.totalCents);
 assert.equal(h.records()[0].quote.tolls.legs[0].crossing,fixture(id).crossing);assert.ok(tolls.validQuote(h.records()[0].quote));
 assert.equal(h.state.creates.length,choice==='now'?1:0);
 const cookie=accepted.headers.getSetCookie().find(s=>s.includes('er_booking_access_')).split(';')[0],calls=h.state.googleCalls;
 h.state.routeResult=()=>{throw Error('Accepted reservations must not be repriced');};
 for(let i=0;i<2;i++)assert.equal((await h.request('/api/booking/'+accepted.body.bookingId+'/checkout',{}, {...origin(h),cookie})).status,200);
 assert.equal(h.state.googleCalls,calls);assert.equal(h.state.creates.length,1);assert.equal(h.state.creates[0].params.line_items[0].price_data.unit_amount,q.body.totalCents);
 assert.equal(h.records()[0].paymentStatus,'unpaid');
});

for(const [id,reason]of [['jfk_unmatched','crossing_not_matched'],['jfk_ambiguous','crossing_ambiguous'],['jfk_gwb_uncertain','congestion_entry_unknown'],['jfk_reverse','reverse_congestion_entry_unknown']])test('synthetic '+id+' remains private and fails closed when Google is also unavailable',async t=>{
 const {h,input}=await create(t,fixture(id)),original=h.state.routeResult;
 h.state.routeResult=r=>{const data=original(r);data.travelAdvisory.tollInfo={};return data;};
 for(const path of ['/api/quote','/api/checkout'])for(const paymentChoice of ['now','later']){
  const r=await h.request(path,{...input,paymentChoice,promoCode:'FIRST15',crossing:'lincoln',supportedMatchCount:1,tolls:{status:'estimated',amountCents:1}});
  assert.equal(r.status,422);assert.equal(r.body.code,'TOLL_ESTIMATE_UNAVAILABLE');assert.equal(r.body.checkoutAllowed,false);assert.equal(r.body.total,undefined);assert.equal(r.body.tollReason,undefined);
 }
 assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);assert.equal(h.testStore.shared.claims.size,0);
 const diagnostics=h.state.logs.filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));assert.equal(diagnostics.length,4);assert.ok(diagnostics.every(d=>d.tollReason==='provider_amount_unknown'));
 assert.doesNotMatch(JSON.stringify(diagnostics),/encodedPolyline|geometryHash|latitude|longitude|matchedFacilities/);
 assert.ok(!JSON.stringify(diagnostics).includes(input.pickup));assert.ok(!JSON.stringify(diagnostics).includes(input.email));
});

for(const fault of ['unknown_money','missing_geometry','provider_error','fallback'])test('JFK quote remains blocked with unusable Google information / '+fault,async t=>{
 const c=fixture('jfk_lincoln'),{h,input}=await create(t,c);
 h.state.routeResult=()=>{
  if(fault==='provider_error')throw Error('private-jfk-provider-marker');
  const data=route(c,mockTollCents);if(['unknown_money','missing_geometry'].includes(fault))data.travelAdvisory.tollInfo={};if(fault==='missing_geometry')delete data.legs;
  if(fault==='fallback')data.unusableForTolls=true;return data;
 };
 for(const path of ['/api/quote','/api/checkout']){
  const r=await h.request(path,{...input,paymentChoice:'later'});assert.equal(r.status,422);assert.equal(r.body.checkoutAllowed,false);
 }
 assert.equal(h.records().length,0);assert.equal(h.state.creates.length,0);assert.ok(!JSON.stringify(h.state.logs).includes('private-jfk-provider-marker'));
});

test('legacy diagnostic vocabulary remains accepted without accepting arbitrary provider text',()=>{
 assert.equal(advance.failureReason('crossing_missing_or_ambiguous'),'crossing_missing_or_ambiguous');
 assert.equal(advance.failureReason('private-jfk-provider-marker'),'estimate_unavailable');
});
